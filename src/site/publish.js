/**
 * Publish a site from the browser (haxtheweb/issues#3341).
 *
 * The Worker packs the site (runtime/publish.cjs: the files the HAX CLI
 * publishes, as a gzipped tarball). This page sends that to the publish
 * broker on the same deployment (api/), which passes it to Surge and streams
 * Surge's progress back. Where there is no broker (the GitHub Pages copy,
 * forks that have not deployed one) the dialog says so and points to
 * Download site and the HAX CLI.
 *
 * Surge credentials: a pasted token, or an email and password the broker
 * turns into a token once. The token is kept in this page's memory only and
 * is gone when the tab closes. The address last used for each site is
 * remembered in this browser (localStorage) as a convenience.
 *
 * HAX Lite is a second place to publish: a hosted HAXcms the person has an
 * account on. That is a one-time move of the site into their account, not a
 * static copy, and it needs no broker: HAX Lite answers this page directly
 * when its owner has listed this origin. Nobody types a secret. The person
 * allows it on HAX Lite's own page (authorization code + PKCE), in a window
 * that starts on hax-lite-callback.html and comes back to it; the two pages
 * talk over a BroadcastChannel. The pass HAX Lite hands back starts one
 * import, lasts ten minutes and is never stored. Only the HAX Lite address
 * and the site path last used are remembered in this browser.
 *
 * shell.js creates this with HaxcmsPublish({ send, isRunning }), where send
 * talks to the Worker.
 */
(function () {
  "use strict";

  const DOMAIN_KEY = "haxcms-browser:publish-domains";
  const HAX_LITE_KEY = "haxcms-browser:publish-hax-lite";
  const HAX_LITE_CHANNEL = "haxcms-browser:hax-lite";
  // how long the person has to allow the publish on HAX Lite, and how long
  // HAX Lite has to build the site afterwards
  const HAX_LITE_APPROVAL_MS = 10 * 60 * 1000;
  const HAX_LITE_IMPORT_MS = 5 * 60 * 1000;

  function byId(id) {
    return document.getElementById(id);
  }

  // same rules as the broker's validDomain (api/_lib/broker.js)
  function cleanDomain(value) {
    const domain = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "");
    if (domain.length < 4 || domain.length > 253) {
      return null;
    }
    const labels = domain.split(".");
    if (labels.length < 2) {
      return null;
    }
    for (const label of labels) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
        return null;
      }
    }
    if (/^\d+$/.test(labels[labels.length - 1])) {
      return null;
    }
    return domain;
  }

  function rememberedDomains() {
    try {
      const value = JSON.parse(
        globalThis.localStorage.getItem(DOMAIN_KEY) || "{}",
      );
      return value && typeof value === "object" ? value : {};
    } catch (e) {
      return {};
    }
  }

  function rememberDomain(site, domain) {
    try {
      const all = rememberedDomains();
      all[site] = domain;
      globalThis.localStorage.setItem(DOMAIN_KEY, JSON.stringify(all));
    } catch (e) {
      // storage can be off; this is only a convenience
    }
  }

  // a new address for a first publish: the site's name plus a few random
  // characters, so it does not collide with someone else's site
  function suggestDomain(name) {
    const base =
      String(name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "hax-site";
    const suffix = Array.from(
      globalThis.crypto.getRandomValues(new Uint8Array(3)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return base + "-" + suffix + ".surge.sh";
  }

  // --- HAX Lite ---------------------------------------------------------

  // The origin of a HAX Lite from what someone typed: https, or plain http
  // only on this computer (for people running their own).
  function cleanHaxLite(value) {
    let text = String(value || "").trim();
    if (!text) {
      return null;
    }
    if (!/^https?:\/\//i.test(text)) {
      text = "https://" + text;
    }
    let url;
    try {
      url = new URL(text);
    } catch (e) {
      return null;
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.username || url.password) {
      return null;
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return null;
    }
    return url.origin;
  }

  // HAX Lite's rule for a site path
  function cleanSitePath(value) {
    const path = String(value || "").trim();
    return /^[a-z][a-z0-9-]{0,39}$/.test(path) ? path : null;
  }

  function suggestSitePath(name) {
    const path = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 40);
    return path || "my-site";
  }

  function rememberedHaxLite() {
    try {
      const value = JSON.parse(
        globalThis.localStorage.getItem(HAX_LITE_KEY) || "{}",
      );
      return value && typeof value === "object" ? value : {};
    } catch (e) {
      return {};
    }
  }

  // the address and the path only: never a code or a pass
  function rememberHaxLite(address, site, path) {
    try {
      const all = rememberedHaxLite();
      all.address = address;
      all.paths = all.paths && typeof all.paths === "object" ? all.paths : {};
      all.paths[site] = path;
      globalThis.localStorage.setItem(HAX_LITE_KEY, JSON.stringify(all));
    } catch (e) {
      // storage is a convenience
    }
  }

  function base64url(bytes) {
    let text = "";
    for (const byte of bytes) {
      text += String.fromCharCode(byte);
    }
    return btoa(text)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function randomText(length) {
    return base64url(globalThis.crypto.getRandomValues(new Uint8Array(length)));
  }

  // What this HAX Lite accepts (its /.well-known/hax-lite-publish). Every
  // address it names must be on the HAX Lite itself: the pass and the site
  // are never sent anywhere else.
  async function describeHaxLite(origin) {
    let response;
    try {
      response = await fetch(origin + "/.well-known/hax-lite-publish", {
        cache: "no-store",
      });
    } catch (e) {
      throw new Error(
        "Could not reach " + origin + ". Check the address and try again.",
      );
    }
    let body = null;
    if (response.ok) {
      try {
        body = await response.json();
      } catch (e) {
        body = null;
      }
    }
    if (!body || body.service !== "hax-lite-publish" || !body.endpoints) {
      throw new Error(
        origin + " does not accept sites published from other tools.",
      );
    }
    if (!body.doors || body.doors.connect !== true) {
      throw new Error(
        origin +
          " has not turned on publishing from other websites. Use Download site, then bring the site in from My HAX there.",
      );
    }
    const endpoints = {};
    for (const name of ["authorize", "token", "sites", "imports"]) {
      let url;
      try {
        url = new URL(String(body.endpoints[name]).replace("{id}", "id"));
      } catch (e) {
        url = null;
      }
      if (!url || url.origin !== origin) {
        throw new Error(origin + " gave an answer this page cannot use.");
      }
      endpoints[name] = String(body.endpoints[name]);
    }
    return { endpoints, maxBytes: Number(body.maxBytes) || 0 };
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  // Read a newline-delimited JSON stream, calling onLine for each object.
  async function readLines(response, onLine) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value || new Uint8Array(), {
        stream: !done,
      });
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          try {
            onLine(JSON.parse(line));
          } catch (e) {
            // not JSON: ignore the line
          }
        }
      }
      if (done) {
        break;
      }
    }
    const rest = buffered.trim();
    if (rest) {
      try {
        onLine(JSON.parse(rest));
      } catch (e) {
        // not JSON
      }
    }
  }

  async function errorMessage(response, fallback) {
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") {
        return body.error;
      }
    } catch (e) {
      // not JSON
    }
    return fallback + " (" + response.status + ")";
  }

  globalThis.HaxcmsPublish = function HaxcmsPublish(options) {
    const send = options.send;
    const isRunning = options.isRunning;

    const button = byId("publish-button");
    const dialog = byId("publish");
    const form = byId("publish-form");
    const none = byId("publish-none");
    const common = byId("publish-common");
    const fields = byId("publish-fields");
    const haxLiteFields = byId("publish-haxlite");
    const haxLiteAddress = byId("publish-haxlite-address");
    const haxLitePath = byId("publish-haxlite-path");
    const siteSelect = byId("publish-site");
    const domainInput = byId("publish-domain");
    const tokenInput = byId("publish-token");
    const tokenCommand = byId("publish-token-command");
    const emailInput = byId("publish-email");
    const passwordInput = byId("publish-password");
    const tokenPart = byId("publish-auth-token");
    const passwordPart = byId("publish-auth-password");
    const choices = byId("publish-auth-choices");
    const signedIn = byId("publish-signed-in");
    const signedInText = byId("publish-signed-in-text");
    const forget = byId("publish-forget");
    const status = byId("publish-status");
    const limit = byId("publish-limit");
    const submit = byId("publish-submit");
    const cancel = byId("publish-cancel");

    // the broker on this deployment, if there is one
    const brokerBase = new URL("/api/", globalThis.location.origin);
    let broker = null;
    // Surge credentials for this tab: { token, email }
    let surge = null;
    let sites = [];
    let busy = false;

    function setStatus(text, state) {
      status.textContent = text;
      status.dataset.state = state || "";
    }

    // where to publish: "surge" (through the broker) or "haxlite"
    function targetMode() {
      const checked = form.querySelector(
        'input[name="publish-target"]:checked',
      );
      return checked ? checked.value : "surge";
    }

    // Surge needs this deployment's broker; HAX Lite does not
    function showTarget() {
      const lite = targetMode() === "haxlite";
      const any = sites.length > 0;
      common.hidden = !any;
      none.hidden = lite || !!broker;
      fields.hidden = lite || !broker || !any;
      limit.hidden = lite || !(broker && broker.maxBytes);
      haxLiteFields.hidden = !lite || !any;
      submit.hidden = !any || (!lite && !broker);
    }

    function authMode() {
      const checked = form.querySelector('input[name="publish-auth"]:checked');
      return checked ? checked.value : "token";
    }

    function showAuth() {
      signedIn.hidden = !surge;
      choices.hidden = !!surge;
      if (surge) {
        signedInText.textContent = surge.email
          ? "Publishing as " + surge.email + "."
          : "Publishing with the token you gave.";
      }
      const mode = authMode();
      tokenPart.hidden = mode !== "token";
      passwordPart.hidden = mode !== "password";
    }

    function showTokenCommand() {
      const domain = cleanDomain(domainInput.value) || "example.surge.sh";
      tokenCommand.textContent = "surge tokens add --domain " + domain;
    }

    function setBusy(value) {
      busy = value;
      submit.disabled = value;
      siteSelect.disabled = value;
      domainInput.disabled = value;
      haxLiteAddress.disabled = value;
      haxLitePath.disabled = value;
      for (const choice of form.querySelectorAll(
        'input[name="publish-target"]',
      )) {
        choice.disabled = value;
      }
      cancel.disabled = value;
      submit.textContent = value ? "Publishing…" : "Publish";
    }

    function chooseSite() {
      const site = sites.find((item) => item.name === siteSelect.value);
      if (!site) {
        domainInput.value = "";
        haxLitePath.value = "";
        return;
      }
      const lite = rememberedHaxLite();
      haxLitePath.value =
        cleanSitePath(lite.paths && lite.paths[site.name]) ||
        suggestSitePath(site.name);
      if (!haxLiteAddress.value) {
        haxLiteAddress.value = cleanHaxLite(lite.address) || "";
      }
      domainInput.value =
        cleanDomain(rememberedDomains()[site.name]) ||
        cleanDomain(site.domain) ||
        suggestDomain(site.name);
      showTokenCommand();
    }

    // asked each time the dialog opens: the answer is small, and a broker
    // that was out a moment ago, or whose limits changed, is seen again
    async function checkBroker() {
      try {
        const response = await fetch(new URL("status", brokerBase), {
          cache: "no-store",
        });
        const body = response.ok ? await response.json() : null;
        broker =
          body && body.broker === 1 && body.publish && body.publish.surge
            ? { maxBytes: Number(body.publish.surge.maxBytes) || 0 }
            : false;
      } catch (e) {
        broker = false;
      }
      return broker;
    }

    async function open() {
      setStatus("", "");
      const found = await checkBroker();
      if (found && found.maxBytes) {
        limit.textContent =
          "Free publishing from the browser takes sites up to " +
          formatBytes(found.maxBytes) +
          " once packed (text, pages and a few images). For bigger sites, use Download site in the dashboard and publish with the HAX CLI, which has no size limit.";
      }
      try {
        sites = await send("listSites", {});
      } catch (e) {
        sites = [];
      }
      const previous = siteSelect.value;
      siteSelect.textContent = "";
      for (const site of sites) {
        const option = document.createElement("option");
        option.value = site.name;
        option.textContent =
          site.title === site.name
            ? site.name
            : site.title + " (" + site.name + ")";
        siteSelect.append(option);
      }
      if (previous && sites.some((site) => site.name === previous)) {
        siteSelect.value = previous;
      }
      showTarget();
      if (!sites.length) {
        setStatus(
          "There are no sites yet. Make one from the dashboard first.",
          "",
        );
      } else {
        chooseSite();
      }
      showAuth();
      dialog.showModal();
      (sites.length ? siteSelect : cancel).focus();
    }

    async function getToken() {
      if (surge) {
        return surge.token;
      }
      if (authMode() === "token") {
        const token = tokenInput.value.trim();
        if (!/^[A-Za-z0-9._-]{8,512}$/.test(token)) {
          throw new Error("Paste a Surge token to publish.");
        }
        surge = { token, email: "" };
        tokenInput.value = "";
        return token;
      }
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) {
        throw new Error("Enter your Surge email and password.");
      }
      setStatus("Signing in to Surge…", "busy");
      const response = await fetch(new URL("surge/token", brokerBase), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      passwordInput.value = "";
      if (!response.ok) {
        throw new Error(await errorMessage(response, "Could not sign in"));
      }
      const body = await response.json();
      surge = { token: body.token, email: body.email || email };
      return surge.token;
    }

    // Send the packed site through the broker. Surge does not accept
    // requests from browsers (no CORS headers), so there is no way around
    // the broker's size limit from here: bigger sites are stopped before
    // any upload with a way forward.
    async function deploy(domain, token, packed) {
      if (broker.maxBytes && packed.byteLength > broker.maxBytes) {
        throw new Error(
          "This site is " +
            formatBytes(packed.byteLength) +
            " packed, over the " +
            formatBytes(broker.maxBytes) +
            " that can be published from the browser. Use Download site in the dashboard, then publish the folder with the HAX CLI (hax site site:surge), which has no size limit.",
        );
      }
      const response = await fetch(
        new URL(
          "surge/deploy?domain=" + encodeURIComponent(domain),
          brokerBase,
        ),
        {
          method: "PUT",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/gzip",
          },
          body: packed,
        },
      );
      if (!response.ok) {
        if (response.status === 401) {
          surge = null;
          showAuth();
        }
        throw new Error(await errorMessage(response, "Publishing failed"));
      }
      let live = false;
      let failure = "";
      await readLines(response, (line) => {
        if (!line || typeof line !== "object") {
          return;
        }
        if (line.type === "info") {
          live = true;
        } else if (line.type === "error" || line.type === "fail") {
          failure =
            (Array.isArray(line.messages) && line.messages.join(" ")) ||
            line.message ||
            line.msg ||
            "Surge stopped the publish";
        } else if (line.type) {
          setStatus("Publishing… (" + String(line.type) + ")", "busy");
        }
      });
      if (failure) {
        throw new Error(String(failure));
      }
      if (!live) {
        throw new Error(
          "Surge ended without saying the site is live. Try again.",
        );
      }
    }

    // --- HAX Lite ---------------------------------------------------------

    // Ask the person to allow the publish on HAX Lite's own page, in the
    // window `popup` (opened on hax-lite-callback.html while the click was
    // still fresh, so the browser lets it open). Resolves with the one-time
    // code; the window is closed whatever happens.
    function approveOnHaxLite(popup, id, authorize, state) {
      return new Promise((resolve, reject) => {
        const channel = new BroadcastChannel(HAX_LITE_CHANNEL);
        let sent = false;
        let finished = false;
        function finish(error, code) {
          if (finished) {
            return;
          }
          finished = true;
          clearInterval(watching);
          clearTimeout(ready);
          clearTimeout(deadline);
          channel.close();
          try {
            popup.close();
          } catch (e) {
            // already gone
          }
          if (error) {
            reject(error);
          } else {
            resolve(code);
          }
        }
        // the person closed the window instead of answering
        const watching = setInterval(() => {
          if (popup.closed) {
            finish(
              new Error("Publishing was cancelled: the window was closed."),
            );
          }
        }, 500);
        // The return page comes straight from the web server. A browser that
        // has not picked up this version yet answers with something else, and
        // a reload fixes that.
        const ready = setTimeout(() => {
          if (!sent) {
            finish(
              new Error(
                "The publish window did not start. Reload this page once, then publish again.",
              ),
            );
          }
        }, 15000);
        const deadline = setTimeout(() => {
          finish(new Error("Publishing timed out waiting for an answer."));
        }, HAX_LITE_APPROVAL_MS);
        channel.onmessage = (event) => {
          const message = event.data;
          if (!message || typeof message !== "object") {
            return;
          }
          if (message.type === "ready" && message.id === id && !sent) {
            sent = true;
            channel.postMessage({ type: "go", id, url: authorize });
            setStatus("Waiting for you to allow this on HAX Lite…", "busy");
            return;
          }
          // an answer for another publish, or not from this request
          if (message.type !== "result" || message.state !== state) {
            return;
          }
          if (message.error || !message.code) {
            finish(
              new Error(
                message.error === "access_denied"
                  ? "Nothing was published: the request was declined on HAX Lite."
                  : "HAX Lite did not approve the publish.",
              ),
            );
          } else {
            finish(null, String(message.code));
          }
        };
      });
    }

    async function haxLiteJson(response, fallback) {
      if (!response.ok) {
        throw new Error(await errorMessage(response, fallback));
      }
      try {
        return await response.json();
      } catch (e) {
        throw new Error(fallback);
      }
    }

    // Move one site into the person's HAX Lite account. `popup` is the
    // window opened for the approval.
    async function publishToHaxLite(popup, id, site, origin, sitePath) {
      const returnPage = new URL(
        "hax-lite-callback.html",
        globalThis.location.origin + globalThis.location.pathname,
      ).href;
      setStatus("Asking " + origin + " what it accepts…", "busy");
      const lite = await describeHaxLite(origin);
      setStatus("Packing " + site.name + "…", "busy");
      const packed = await send("packSite", { name: site.name });
      if (lite.maxBytes && packed.body.byteLength > lite.maxBytes) {
        throw new Error(
          "This site is " +
            formatBytes(packed.body.byteLength) +
            " packed, over the " +
            formatBytes(lite.maxBytes) +
            " this HAX Lite accepts.",
        );
      }
      const state = randomText(24);
      const verifier = randomText(48);
      const challenge = base64url(
        new Uint8Array(
          await globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        ),
      );
      const authorize = new URL(lite.endpoints.authorize);
      authorize.searchParams.set("redirect_uri", returnPage);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      const code = await approveOnHaxLite(popup, id, authorize.href, state);

      setStatus("Allowed. Sending the site to HAX Lite…", "busy");
      // the pass lives in this function only: one import, ten minutes
      const granted = await haxLiteJson(
        await fetch(lite.endpoints.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: returnPage,
          }),
        }),
        "HAX Lite did not accept the approval",
      );
      if (!granted || typeof granted.access_token !== "string") {
        throw new Error("HAX Lite did not accept the approval.");
      }
      const authorization = "Bearer " + granted.access_token;
      const target = new URL(lite.endpoints.sites);
      target.searchParams.set("slug", sitePath);
      if (site.title && site.title !== site.name) {
        target.searchParams.set("title", String(site.title).slice(0, 120));
      }
      const started = await haxLiteJson(
        await fetch(target.href, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/gzip",
            "idempotency-key": randomText(24),
          },
          body: packed.body,
        }),
        "HAX Lite did not accept the site",
      );
      if (
        !started ||
        !started.import ||
        typeof started.import.id !== "string"
      ) {
        throw new Error("HAX Lite did not accept the site.");
      }
      rememberHaxLite(origin, site.name, sitePath);

      // HAX Lite builds the site, then copies the pages and files in
      const statusAddress = lite.endpoints.imports.replace(
        "{id}",
        encodeURIComponent(started.import.id),
      );
      const until = Date.now() + HAX_LITE_IMPORT_MS;
      let result = started;
      while (
        result.import &&
        (result.import.status === "pending" ||
          result.import.status === "running")
      ) {
        if (Date.now() > until) {
          throw new Error(
            "HAX Lite is still building the site. Check My HAX on " +
              origin +
              " in a few minutes.",
          );
        }
        const report = (result.import && result.import.report) || {};
        setStatus(
          "HAX Lite is building the site (" +
            (Number(report.pages) || 0) +
            " pages)…",
          "busy",
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        result = await haxLiteJson(
          await fetch(statusAddress, { headers: { authorization } }),
          "Could not ask HAX Lite how the publish is going",
        );
      }
      return result;
    }

    // What HAX Lite left out or changed, in its own words (shown as text).
    function haxLiteNotes(report) {
      const notes = []
        .concat(Array.isArray(report.skipped) ? report.skipped : [])
        .concat(Array.isArray(report.warnings) ? report.warnings : [])
        .filter((note) => typeof note === "string" && note);
      if (!notes.length) {
        return "";
      }
      return (
        " " +
        notes.length +
        (notes.length === 1 ? " thing was" : " things were") +
        " left out or changed, for example: " +
        notes[0].slice(0, 200) +
        "."
      );
    }

    function showHaxLiteResult(result, origin) {
      const outcome = (result && result.import) || {};
      const report = outcome.report || {};
      const site = (result && result.site) || {};
      let address = null;
      try {
        const url = new URL(String(site.url));
        // only ever a link to a web page
        address = /^https?:$/.test(url.protocol) ? url : null;
      } catch (e) {
        address = null;
      }
      if (outcome.status === "failed" || !address) {
        throw new Error(
          String(report.error || "HAX Lite could not create the site."),
        );
      }
      const pages =
        (Number(report.pagesImported) || 0) +
        " of " +
        (Number(report.pages) || 0) +
        " pages";
      status.textContent = "";
      status.dataset.state = outcome.status === "complete" ? "ready" : "error";
      const link = document.createElement("a");
      link.href = address.href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = address.href;
      status.append(
        outcome.status === "complete"
          ? "Published. " + pages + " are now in your HAX Lite account at "
          : "Published with problems: " +
              pages +
              " were added. " +
              String(report.error || "") +
              " The site is at ",
        link,
        ". From now on, edit it from My HAX on " +
          origin +
          "." +
          haxLiteNotes(report),
      );
    }

    async function publishHaxLite() {
      const site = sites.find((item) => item.name === siteSelect.value);
      const origin = cleanHaxLite(haxLiteAddress.value);
      const sitePath = cleanSitePath(haxLitePath.value);
      if (!site) {
        setStatus("Pick a site to publish.", "error");
        siteSelect.focus();
        return;
      }
      if (!origin) {
        setStatus(
          "Enter the address of your HAX Lite, like https://lite.example.edu.",
          "error",
        );
        haxLiteAddress.focus();
        return;
      }
      if (!sitePath) {
        setStatus(
          "Enter a site path: a lowercase letter, then up to 39 lowercase letters, numbers or hyphens.",
          "error",
        );
        haxLitePath.focus();
        return;
      }
      if (
        typeof globalThis.BroadcastChannel !== "function" ||
        !globalThis.crypto ||
        !globalThis.crypto.subtle
      ) {
        setStatus(
          "This browser cannot publish to HAX Lite from here. Use Download site, then bring the site in from My HAX.",
          "error",
        );
        return;
      }
      // opened now, while the click is fresh, or the browser blocks it; it
      // waits on this origin's own page until there is somewhere to go
      const id = randomText(12);
      const popup = globalThis.open(
        new URL(
          "hax-lite-callback.html?id=" + encodeURIComponent(id),
          globalThis.location.origin + globalThis.location.pathname,
        ).href,
        "haxcms-hax-lite",
        "popup,width=560,height=760",
      );
      if (!popup) {
        setStatus(
          "The browser blocked the window HAX Lite needs. Allow pop-ups for this page and publish again.",
          "error",
        );
        return;
      }
      setBusy(true);
      try {
        showHaxLiteResult(
          await publishToHaxLite(popup, id, site, origin, sitePath),
          origin,
        );
      } catch (error) {
        setStatus(String((error && error.message) || error), "error");
      } finally {
        try {
          popup.close();
        } catch (e) {
          // already gone
        }
        setBusy(false);
      }
    }

    async function publish(event) {
      event.preventDefault();
      if (busy) {
        return;
      }
      if (targetMode() === "haxlite") {
        await publishHaxLite();
        return;
      }
      if (!broker) {
        return;
      }
      const site = siteSelect.value;
      const domain = cleanDomain(domainInput.value);
      if (!site) {
        setStatus("Pick a site to publish.", "error");
        siteSelect.focus();
        return;
      }
      if (!domain) {
        setStatus(
          "Enter an address like my-site.surge.sh (letters, numbers and hyphens).",
          "error",
        );
        domainInput.focus();
        return;
      }
      setBusy(true);
      try {
        const token = await getToken();
        showAuth();
        setStatus("Packing " + site + "…", "busy");
        const packed = await send("packSite", { name: site });
        setStatus(
          "Sending " +
            packed.files +
            " files (" +
            formatBytes(packed.body.byteLength) +
            ") to Surge…",
          "busy",
        );
        await deploy(domain, token, packed.body);
        rememberDomain(site, domain);
        status.textContent = "";
        status.dataset.state = "ready";
        const link = document.createElement("a");
        // domain is a checked hostname (cleanDomain), which encoding leaves
        // as it is; encoding keeps it from ever being more than a host
        link.href = "https://" + encodeURIComponent(domain) + "/";
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "https://" + domain;
        status.append("Published. Your site is live at ", link, ".");
      } catch (error) {
        setStatus(String((error && error.message) || error), "error");
      } finally {
        setBusy(false);
        showAuth();
      }
    }

    button.addEventListener("click", () => {
      if (isRunning()) {
        open();
      }
    });
    form.addEventListener("submit", publish);
    form.addEventListener("change", (event) => {
      if (event.target.name === "publish-auth") {
        showAuth();
      }
      if (event.target.name === "publish-target") {
        setStatus("", "");
        showTarget();
      }
    });
    siteSelect.addEventListener("change", chooseSite);
    domainInput.addEventListener("input", showTokenCommand);
    forget.addEventListener("click", () => {
      surge = null;
      showAuth();
      (authMode() === "token" ? tokenInput : emailInput).focus();
    });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", (event) => {
      if (busy) {
        event.preventDefault();
      }
    });
    dialog.addEventListener("close", () => {
      tokenInput.value = "";
      passwordInput.value = "";
      button.focus();
    });

    return {
      show(running) {
        button.hidden = !running;
      },
    };
  };
})();
