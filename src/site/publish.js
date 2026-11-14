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
 * shell.js creates this with HaxcmsPublish({ send, isRunning }), where send
 * talks to the Worker.
 */
(function () {
  "use strict";

  const DOMAIN_KEY = "haxcms-browser:publish-domains";

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
    const fields = byId("publish-fields");
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
      cancel.disabled = value;
      submit.textContent = value ? "Publishing…" : "Publish";
    }

    function chooseSite() {
      const site = sites.find((item) => item.name === siteSelect.value);
      if (!site) {
        domainInput.value = "";
        return;
      }
      domainInput.value =
        cleanDomain(rememberedDomains()[site.name]) ||
        cleanDomain(site.domain) ||
        suggestDomain(site.name);
      showTokenCommand();
    }

    // a broker that answered is remembered; one that did not is asked again
    // next time, in case it was only out for a moment
    async function checkBroker() {
      if (broker) {
        return broker;
      }
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
      none.hidden = !!found;
      fields.hidden = !found;
      submit.hidden = !found;
      if (found) {
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
        if (!sites.length) {
          fields.hidden = true;
          submit.hidden = true;
          setStatus(
            "There are no sites yet. Make one from the dashboard first.",
            "",
          );
        } else {
          chooseSite();
        }
        showAuth();
      }
      dialog.showModal();
      (found && sites.length ? siteSelect : cancel).focus();
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

    // Send the packed site through the broker, or (too large for it)
    // straight to Surge, which only works if Surge accepts the request from
    // a browser.
    async function deploy(domain, token, packed) {
      const viaBroker =
        !broker.maxBytes || packed.byteLength <= broker.maxBytes;
      let response;
      if (viaBroker) {
        response = await fetch(
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
      } else {
        try {
          response = await fetch(
            "https://surge.surge.sh/" + encodeURIComponent(domain),
            {
              method: "PUT",
              headers: {
                authorization: "Basic " + btoa("token:" + token),
                "content-type": "application/gzip",
                accept: "application/x-ndjson",
              },
              body: packed,
            },
          );
        } catch (e) {
          throw new Error(
            "This site (" +
              formatBytes(packed.byteLength) +
              " packed) is too large to publish from the browser. Use Download site in the dashboard and publish it with the HAX CLI.",
          );
        }
      }
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

    async function publish(event) {
      event.preventDefault();
      if (busy || !broker) {
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
        link.href = "https://" + domain + "/";
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
