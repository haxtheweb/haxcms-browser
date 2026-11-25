/**
 * Open in HAX: a site handed over by the tab that opened this one
 * (haxtheweb/issues#3405).
 *
 * A site generator (GeoCities Generator, anything that builds a HAXcms site
 * in the browser) opens this page as ?handoff=1 with window.open and sends
 * the finished site zip with postMessage. Nothing passes through a server:
 * the zip moves from that tab's memory to this one, then into HAXcms through
 * its own import and create routes (site/import/haxcms with an uploaded site
 * zip, then sites), the same requests the dashboard makes, so it is checked
 * and sanitized like any import. The site then opens in the editor.
 *
 * The contract is protocol "hax-handoff", version 1 (README, "Open in HAX"):
 *   ready    this page -> opener     { versions: [1] }
 *   offer    opener                  { generator: { name, url }, title, format: "haxcms-zip", size }
 *   consent  this page               { allowed }
 *   payload  opener                  { data: Blob | ArrayBuffer }
 *   result   this page               { ok, name } or { ok: false, error }
 *
 * Rules this file keeps:
 * - Messages are taken only from the window that opened this tab, and after
 *   the first offer only from that offer's origin. One handoff per tab;
 *   ?handoff is taken out of the address once read.
 * - Nothing is read from a payload until the person allows the offer in the
 *   dialog, which names the sending origin (the browser's, not the sender's
 *   claim) and the site's title.
 * - A payload bigger than its offer said, or than MAX_BYTES, is refused.
 * - Unknown versions and types are ignored; every wait has a time limit.
 *
 * shell.js creates this with HaxcmsHandoff({ request, userTokens, canSave,
 * openPage, notify }), calls take() once at start-up and started() each time
 * HAXcms is running. request sends one request through the Worker as the
 * signed-in local user and resolves { status, json }.
 */
(function () {
  "use strict";

  const PROTOCOL = "hax-handoff";
  const VERSION = 1;
  const FORMAT = "haxcms-zip";
  const MAX_BYTES = 100 * 1024 * 1024;
  const WAIT_MS = 2 * 60 * 1000;

  function byId(id) {
    return document.getElementById(id);
  }

  // "1.2 MB" and the like
  function size(bytes) {
    if (bytes < 1024) {
      return bytes + " bytes";
    }
    if (bytes < 1024 * 1024) {
      return Math.round(bytes / 1024) + " KB";
    }
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function text(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  // an http(s) address, or ""
  function webAddress(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : "";
    } catch (e) {
      return "";
    }
  }

  function isMessage(data, type) {
    return (
      !!data &&
      typeof data === "object" &&
      data.protocol === PROTOCOL &&
      data.version === VERSION &&
      data.type === type
    );
  }

  // what an import refusal's reason means for the sender
  function importError(json) {
    const reason = json && json.data && json.data.reason;
    if (reason === "NOT_A_ZIP") {
      return "not-a-zip";
    }
    if (reason === "INVALID_SITE") {
      return "invalid-site";
    }
    if (reason === "ZIP_BUDGET") {
      return "too-large";
    }
    return "import-failed";
  }

  globalThis.HaxcmsHandoff = function (options) {
    const dialog = byId("handoff");
    const from = byId("handoff-from");
    const title = byId("handoff-site");
    const details = byId("handoff-details");
    const status = byId("handoff-status");
    const allowButton = byId("handoff-allow");
    const declineButton = byId("handoff-decline");

    let opener = null;
    let origin = "";
    let offer = null;
    let state = "off"; // waiting-offer, asking, waiting-payload, importing, done
    let timer = null;
    let markRunning = null;
    const running = new Promise((resolve) => {
      markRunning = resolve;
    });

    function post(type, fields) {
      if (!opener || opener.closed) {
        return;
      }
      try {
        opener.postMessage(
          Object.assign({ protocol: PROTOCOL, version: VERSION, type }, fields),
          // nothing but "ready" (no data) goes out before an origin is known
          origin || "*",
        );
      } catch (e) {
        console.warn("[haxcms-browser] handoff", e);
      }
    }

    function wait(next) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (state === "waiting-offer" || state === "waiting-payload") {
          finish({ ok: false, error: "timeout" });
          options.notify(
            "The site that was being sent did not arrive in time.",
          );
        }
      }, WAIT_MS);
      state = next;
    }

    function finish(result) {
      clearTimeout(timer);
      state = "done";
      globalThis.removeEventListener("message", onMessage);
      if (dialog.open) {
        dialog.close();
      }
      post("result", result);
    }

    function ask() {
      const sender = new URL(origin).host;
      from.textContent = sender;
      title.textContent = offer.title || "Untitled site";
      details.textContent =
        (offer.generator.name
          ? "It says it comes from " + offer.generator.name + ". "
          : "") +
        "Size: " +
        size(offer.size) +
        ". It becomes a new site here, in this browser; nothing is sent " +
        "anywhere else.";
      status.textContent = "";
      state = "asking";
      clearTimeout(timer);
      dialog.showModal();
      allowButton.focus();
    }

    function onMessage(event) {
      if (state === "done" || event.source !== opener) {
        return;
      }
      if (origin && event.origin !== origin) {
        return;
      }
      const data = event.data;
      if (state === "waiting-offer" && isMessage(data, "offer")) {
        const declared = Number(data.size);
        const generator =
          data.generator && typeof data.generator === "object"
            ? data.generator
            : {};
        origin = event.origin;
        offer = {
          title: text(data.title, 200),
          generator: {
            name: text(generator.name, 100),
            url: webAddress(generator.url),
          },
          size: Number.isFinite(declared) && declared > 0 ? declared : 0,
        };
        if (data.format !== FORMAT) {
          finish({ ok: false, error: "not-a-zip" });
          return;
        }
        if (offer.size === 0 || offer.size > MAX_BYTES) {
          finish({ ok: false, error: "too-large" });
          options.notify(
            "A site was offered from " +
              new URL(origin).host +
              ", but it is larger than " +
              size(MAX_BYTES) +
              ". Download it there and upload it here instead.",
          );
          return;
        }
        ask();
        return;
      }
      if (state === "waiting-payload" && isMessage(data, "payload")) {
        receive(data.data);
      }
    }

    async function receive(data) {
      state = "importing";
      clearTimeout(timer);
      const blob =
        data instanceof Blob
          ? data
          : data instanceof ArrayBuffer
            ? new Blob([data])
            : null;
      if (!blob) {
        finish({ ok: false, error: "not-a-zip" });
        return;
      }
      if (blob.size > offer.size || blob.size > MAX_BYTES) {
        finish({ ok: false, error: "too-large" });
        options.notify("The site that arrived was larger than offered.");
        return;
      }
      options.notify("Opening the site from " + new URL(origin).host + "...");
      await running;
      if (!options.canSave()) {
        finish({ ok: false, error: "import-failed" });
        options.notify(
          "HAX is open in another tab, which saves your sites. Close it and " +
            "send the site again.",
        );
        return;
      }
      try {
        const name = await importSite(blob);
        finish({ ok: true, name });
        options.openPage(name, "");
      } catch (error) {
        console.warn("[haxcms-browser] handoff", error);
        finish({ ok: false, error: error.handoff || "import-failed" });
        options.notify(
          "The site from " +
            new URL(origin).host +
            " could not be opened: " +
            String((error && error.message) || error),
        );
      }
    }

    // the zip through HAXcms's import, then a new site from what it read
    async function importSite(blob) {
      const form = new FormData();
      form.append("file", blob, "site.zip");
      // let the browser write the multipart body and its boundary
      const packed = new Request("https://handoff.invalid/", {
        method: "POST",
        body: form,
      });
      const imported = await options.request({
        method: "POST",
        url: "/system/api/v1/site/import/haxcms",
        headers: Object.assign(
          { "content-type": packed.headers.get("content-type") },
          await options.userTokens(),
        ),
        body: await packed.arrayBuffer(),
      });
      const read = imported.json && imported.json.data;
      if (imported.status !== 200 || !read || !Array.isArray(read.items)) {
        const error = new Error(
          (read && read.error) || "HAXcms could not read the site",
        );
        error.handoff = importError(imported.json);
        throw error;
      }
      const about = read.site && typeof read.site === "object" ? read.site : {};
      const name = text(read.filename, 200) || offer.title || "my-site";
      const make = async (theme) => {
        const site = {
          name,
          // the site's own title (createSite keeps it as plain text), else
          // the one the person was shown when asked
          title: text(about.title, 200) || offer.title || "",
          description: text(about.description, 500) || offer.title,
        };
        if (theme) {
          site.theme = theme;
        }
        return options.request({
          method: "POST",
          url: "/system/api/v1/sites",
          headers: Object.assign(
            { "content-type": "application/json" },
            await options.userTokens(),
          ),
          body: new TextEncoder().encode(
            JSON.stringify({
              site,
              build: {
                type: "haxcms",
                structure: "import",
                items: read.items,
                files: read.files || {},
                // the site's own code (custom theme), staged by the import
                siteFiles: read.siteFiles || {},
              },
            }),
          ).buffer,
        });
      };
      const theme = text(about.theme, 100);
      let created = await make(theme);
      if (created.status === 400 && theme) {
        // a theme HAXcms can't select: not in its registry, and not the
        // site's own custom build (which createSite keeps as the theme): the
        // default
        created = await make("");
      }
      const address = String((created.json && created.json.link) || "");
      const made = /\/_sites\/([^/]+)\/?$/.exec(address);
      if (created.status !== 200 || !made) {
        throw new Error(
          "HAXcms could not make the site (" + created.status + ")",
        );
      }
      return decodeURIComponent(made[1]);
    }

    allowButton.addEventListener("click", () => {
      if (state !== "asking") {
        return;
      }
      dialog.close();
      post("consent", { allowed: true });
      wait("waiting-payload");
    });
    function decline() {
      if (state !== "asking") {
        return;
      }
      post("consent", { allowed: false });
      finish({ ok: false, error: "declined" });
    }
    declineButton.addEventListener("click", decline);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      decline();
    });

    return {
      /**
       * Reads ?handoff=1 once and takes it out of the address. With an
       * opener, says ready and waits for its offer. True when a handoff
       * was asked for.
       */
      take() {
        let url;
        try {
          url = new URL(globalThis.location.href);
        } catch (e) {
          return false;
        }
        if (!url.searchParams.has("handoff")) {
          return false;
        }
        url.searchParams.delete("handoff");
        globalThis.history.replaceState(globalThis.history.state, "", url.href);
        opener = globalThis.opener || null;
        if (!opener) {
          options.notify(
            "This link is for a site sent from another tab. Use the Open in " +
              "HAX button where the site was made.",
          );
          return false;
        }
        globalThis.addEventListener("message", onMessage);
        wait("waiting-offer");
        post("ready", { versions: [VERSION] });
        return true;
      },
      /** HAXcms is running: a received site can be imported. */
      started() {
        markRunning();
      },
    };
  };
})();
