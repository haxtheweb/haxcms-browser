/**
 * Publish to a Waypoint (haxtheweb/issues#3422).
 *
 * A Waypoint is a server that builds a static copy of a site and serves it
 * at a web address. You keep editing here; publishing again to the same name
 * replaces what is there, and the Waypoint keeps earlier versions to go back
 * to. It needs no publish broker: a Waypoint answers this page directly when
 * its operator has listed this origin, so it works on every copy of the page.
 *
 * Nobody types a secret. The person signs in and allows it on the Waypoint's
 * own page (authorization code + PKCE, no client secret), in a window that
 * starts on waypoint-callback.html and comes back to it; the two pages talk
 * over a BroadcastChannel, which only reaches pages of this origin. The pass
 * the Waypoint hands back lasts fifteen minutes, only works from this origin,
 * and is held in one function call: never stored or logged. With it this
 * page makes the site on the Waypoint if the person has none of that name,
 * sends the packed site, and waits while the Waypoint checks and builds it.
 * Every address used must be on the Waypoint the person named. Only its
 * address and the site name last used are remembered in this browser.
 *
 * publish.js calls HaxcmsPublishWaypoint.publish(ctx).
 */
(function (root) {
  "use strict";

  const STORE_KEY = "haxcms-browser:publish-waypoint";
  const CHANNEL = "haxcms-browser:waypoint";
  const RETURN_PAGE = "waypoint-callback.html";
  // how long the person has to sign in and allow it, and how long a Waypoint
  // has to check and build the site once it has it
  const APPROVAL_MS = 10 * 60 * 1000;
  const BUILD_MS = 10 * 60 * 1000;

  // The origin of a Waypoint from what someone typed: https, or plain http
  // only on this computer (for people running their own).
  function cleanAddress(value) {
    let text = String(value || "").trim();
    if (!text) {
      return null;
    }
    if (!/^https?:\/\//i.test(text)) {
      // another kind of address (ftp://…) is not a Waypoint
      if (text.indexOf("://") !== -1) {
        return null;
      }
      text = "https://" + text;
    }
    let url;
    try {
      url = new URL(text);
    } catch (e) {
      return null;
    }
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      /\.localhost$/.test(url.hostname);
    if (url.username || url.password) {
      return null;
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return null;
    }
    return url.origin;
  }

  // a Waypoint's rule for a site name, which becomes part of its address
  function cleanName(value) {
    const name = String(value || "")
      .trim()
      .toLowerCase();
    return /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name) ? name : null;
  }

  function suggestName(name) {
    const suggested = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40)
      .replace(/-+$/, "");
    return cleanName(suggested) || "my-site";
  }

  function remembered() {
    try {
      const value = JSON.parse(root.localStorage.getItem(STORE_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch (e) {
      return {};
    }
  }

  // the address and the name only: never a code or a pass
  function remember(address, site, name) {
    try {
      const all = remembered();
      all.address = address;
      all.names = all.names && typeof all.names === "object" ? all.names : {};
      all.names[site] = name;
      root.localStorage.setItem(STORE_KEY, JSON.stringify(all));
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
    return base64url(root.crypto.getRandomValues(new Uint8Array(length)));
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  // a Waypoint's answer as JSON, or its own words for what went wrong
  async function answer(response, fallback) {
    let body = null;
    try {
      body = await response.json();
    } catch (e) {
      body = null;
    }
    if (!response.ok) {
      throw new Error(
        body && typeof body.error === "string"
          ? body.error
          : fallback + " (" + response.status + ")",
      );
    }
    if (!body) {
      throw new Error(fallback);
    }
    return body;
  }

  // What this Waypoint is and where to send things (its /.well-known/waypoint).
  // Every address it names must be on the Waypoint itself: the pass and the
  // site are never sent anywhere else.
  async function describe(origin) {
    let response;
    try {
      response = await fetch(origin + "/.well-known/waypoint", {
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
    if (!body || body.waypoint !== 1 || !body.endpoints) {
      throw new Error(origin + " is not a Waypoint.");
    }
    if (!body.connect || body.beam !== true) {
      throw new Error(
        origin +
          " does not let people publish from other websites. Use Download site, then ask whoever runs that Waypoint to publish it.",
      );
    }
    const found = {};
    const wanted = [
      [body.connect, "authorize"],
      [body.connect, "token"],
      [body.connect, "account"],
      [body.connect, "sites"],
      [body.endpoints, "site"],
      [body.endpoints, "beams"],
      [body.endpoints, "previewLink"],
      [body.endpoints, "jobs"],
    ];
    for (const [from, name] of wanted) {
      let url;
      try {
        url = new URL(
          String(from[name]).replace("{name}", "name").replace("{id}", "id"),
        );
      } catch (e) {
        url = null;
      }
      if (!url || url.origin !== origin) {
        throw new Error(origin + " gave an answer this page cannot use.");
      }
      found[name] = String(from[name]);
    }
    const own = body.selfService || {};
    return {
      endpoints: found,
      maxBytes:
        Number(own.archiveBytes) ||
        Number(body.limits && body.limits.archiveBytes) ||
        0,
    };
  }

  // Ask the person to sign in and allow the publish on the Waypoint's own
  // page, in the window `popup` (opened on waypoint-callback.html while the
  // click was still fresh, so the browser lets it open). Resolves with the
  // one-time code; the window is closed whatever happens.
  function approve(popup, id, authorize, state, setStatus) {
    return new Promise((resolve, reject) => {
      const channel = new BroadcastChannel(CHANNEL);
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
          finish(new Error("Publishing was cancelled: the window was closed."));
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
      }, APPROVAL_MS);
      channel.onmessage = (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") {
          return;
        }
        if (message.type === "ready" && message.id === id && !sent) {
          sent = true;
          channel.postMessage({ type: "go", id, url: authorize });
          setStatus(
            "Waiting for you to sign in and allow this on the Waypoint…",
            "busy",
          );
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
                ? "Nothing was published: the request was declined on the Waypoint."
                : "The Waypoint did not approve the publish.",
            ),
          );
        } else {
          finish(null, String(message.code));
        }
      };
    });
  }

  // Ask the Waypoint how a job is going until it is done. A Waypoint does
  // one job at a time, so this can wait behind other people's builds.
  async function waitFor(waypoint, authorization, job, doing, setStatus) {
    const address = (id) =>
      waypoint.endpoints.jobs.replace("{id}", encodeURIComponent(id));
    const until = Date.now() + BUILD_MS;
    let current = job;
    while (
      current &&
      (current.status === "queued" || current.status === "running")
    ) {
      if (Date.now() > until) {
        throw new Error(
          "The Waypoint is still working on it. Look at My sites there in a few minutes.",
        );
      }
      const steps = Array.isArray(current.progress) ? current.progress : [];
      setStatus(
        steps.length ? String(steps[steps.length - 1]) + "…" : doing,
        "busy",
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const told = await answer(
        await fetch(address(current.id), { headers: { authorization } }),
        "Could not ask the Waypoint how the publish is going",
      );
      current = told.job;
    }
    if (!current || current.status !== "done") {
      throw new Error(
        String((current && current.error) || "The Waypoint could not finish."),
      );
    }
    return current.result || {};
  }

  // The window the approval happens in. Call this in the click handler,
  // before anything is awaited, or the browser blocks it. Returns
  // { popup, id }, or null when the browser refused.
  function openWindow() {
    const id = randomText(12);
    const popup = root.open(
      new URL(
        RETURN_PAGE + "?id=" + encodeURIComponent(id),
        root.location.origin + root.location.pathname,
      ).href,
      "haxcms-waypoint",
      "popup,width=560,height=760",
    );
    return popup ? { popup, id } : null;
  }

  function supported() {
    return (
      typeof root.BroadcastChannel === "function" &&
      !!root.crypto &&
      !!root.crypto.subtle
    );
  }

  /**
   * Publish one site to the person's account on a Waypoint.
   * ctx: { send, site: { name }, origin, name, preview, setStatus, popup, id }
   * where popup and id come from openWindow(). Resolves with
   * { link, preview, origin }: the site's address, or a preview link when
   * preview is set.
   */
  async function publish(ctx) {
    const { send, site, origin, name, preview, setStatus, popup, id } = ctx;
    const returnPage = new URL(
      RETURN_PAGE,
      root.location.origin + root.location.pathname,
    ).href;
    setStatus("Asking " + origin + " what it accepts…", "busy");
    const waypoint = await describe(origin);
    setStatus("Packing " + site.name + "…", "busy");
    const packed = await send("packSite", { name: site.name });
    if (waypoint.maxBytes && packed.body.byteLength > waypoint.maxBytes) {
      throw new Error(
        "This site is " +
          formatBytes(packed.body.byteLength) +
          " packed, over the " +
          formatBytes(waypoint.maxBytes) +
          " this Waypoint accepts.",
      );
    }
    const state = randomText(24);
    const verifier = randomText(48);
    const challenge = base64url(
      new Uint8Array(
        await root.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const authorize = new URL(waypoint.endpoints.authorize);
    authorize.searchParams.set("redirect_uri", returnPage);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    const code = await approve(popup, id, authorize.href, state, setStatus);

    setStatus("Allowed. Getting ready to send the site…", "busy");
    // the pass lives in this function only: fifteen minutes, never stored
    const granted = await answer(
      await fetch(waypoint.endpoints.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: returnPage,
        }),
      }),
      "The Waypoint did not accept the approval",
    );
    if (typeof granted.access_token !== "string") {
      throw new Error("The Waypoint did not accept the approval.");
    }
    const authorization = "Bearer " + granted.access_token;

    // make the site there unless the person already has one of this name
    const mine = await answer(
      await fetch(waypoint.endpoints.account, { headers: { authorization } }),
      "Could not read your account on the Waypoint",
    );
    const have =
      mine.account && Array.isArray(mine.account.sites)
        ? mine.account.sites
        : [];
    if (!have.some((item) => item && item.name === name)) {
      setStatus("Making " + name + " on the Waypoint…", "busy");
      const making = await answer(
        await fetch(waypoint.endpoints.sites, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
        "The Waypoint could not make the site",
      );
      await waitFor(
        waypoint,
        authorization,
        making.job,
        "Making " + name + " on the Waypoint…",
        setStatus,
      );
    }
    remember(origin, site.name, name);

    const target = new URL(
      waypoint.endpoints.beams.replace("{name}", encodeURIComponent(name)),
    );
    if (!preview) {
      target.searchParams.set("live", "1");
    }
    setStatus(
      "Sending " +
        packed.files +
        " files (" +
        formatBytes(packed.body.byteLength) +
        ") to the Waypoint…",
      "busy",
    );
    const sent = await answer(
      await fetch(target.href, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/gzip",
          "idempotency-key": randomText(24),
        },
        body: packed.body,
      }),
      "The Waypoint did not accept the site",
    );
    // the Waypoint checks the site, cleans the pages and builds it
    await waitFor(
      waypoint,
      authorization,
      sent.job,
      "The Waypoint is checking and building the site…",
      setStatus,
    );

    let link = "";
    if (preview) {
      const asked = await answer(
        await fetch(
          waypoint.endpoints.previewLink.replace(
            "{name}",
            encodeURIComponent(name),
          ),
          { method: "POST", headers: { authorization } },
        ),
        "Could not get a preview link from the Waypoint",
      );
      const made = await waitFor(
        waypoint,
        authorization,
        asked.job,
        "Getting a preview link…",
        setStatus,
      );
      link = String(made.link || "");
    } else {
      const now = await answer(
        await fetch(
          waypoint.endpoints.site.replace("{name}", encodeURIComponent(name)),
          { headers: { authorization } },
        ),
        "Could not ask the Waypoint for the site's address",
      );
      link = String((now.site && now.site.url) || "");
    }
    return { link, preview: !!preview, origin };
  }

  const api = {
    cleanAddress,
    cleanName,
    suggestName,
    remembered,
    supported,
    openWindow,
    publish,
  };

  /* global module */
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.HaxcmsPublishWaypoint = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
