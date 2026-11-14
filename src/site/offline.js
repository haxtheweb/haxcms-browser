/**
 * Install HAX and use it with no connection (haxtheweb/issues#3331).
 *
 * This page can be installed like an app (manifest.webmanifest). Installed,
 * or when the person asks for it under Details, a copy of the whole site is
 * saved in this browser: the host page, the Worker that runs haxcms-nodejs,
 * and the HAXcms front end with the translations for the languages this
 * browser asks for. The service worker (sw.js) then serves that copy, so
 * HAX opens and works with no connection.
 *
 * Rules this file keeps:
 * - Nothing is saved until the person installs the app or asks for offline
 *   use. Until then every load comes from the web server, as before.
 * - A copy is one build, whole. offline-manifest.json (written by
 *   scripts/offline-manifest.mjs) lists every file with its size; a file
 *   that does not arrive whole fails the save, and the copy only counts once
 *   its last entry (the meta record) is written. The copy in use is never
 *   changed in place: an update is saved beside it and replaces it when it
 *   is complete.
 * - A copy does not update itself behind the person's back. When the web
 *   server has a newer build, a notice offers the update; it takes effect
 *   the next time the page is loaded.
 * - Removing the copy is one button here, and reset.html does the same (and
 *   removes the service worker) without needing any of this to work.
 * - Sites are not part of the copy and are never touched by saving,
 *   updating or removing it.
 *
 * Installing is offered once in a notice when the browser says the page can
 * be installed (Chromium), or with how to do it on iPhone and iPad. "Not
 * now" is remembered in this browser for two weeks; the Install button
 * under Details stays.
 *
 * shell.js creates this with HaxcmsOffline({ toast }) and calls start().
 */
(function () {
  "use strict";

  // shared with sw.js and reset.html
  const FORMAT = 1;
  const ALL = "haxcms-browser-offline:";
  const scope = new URL("./", globalThis.location.href).pathname;
  const base = globalThis.location.origin + scope;
  const PREFIX = ALL + FORMAT + ":" + scope + ":";
  const META = base + "__offline/meta.json";
  const FILES = base + "__offline/files.json";
  const MANIFEST = "./offline-manifest.json";
  const LOCALES = "./offline-locales/";
  const PARALLEL = 6;
  // look for a newer build at most this often while the page stays open
  const CHECK_EVERY_MS = 30 * 60 * 1000;

  function byId(id) {
    return document.getElementById(id);
  }

  function megabytes(bytes) {
    return Math.max(1, Math.round(bytes / (1024 * 1024))) + " MB";
  }

  function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  }

  // { name, cache, meta } for the copy in this browser, or null. A cache
  // without its meta record is a save that did not finish, not a copy.
  async function currentCopy() {
    if (!globalThis.caches) {
      return null;
    }
    let best = null;
    for (const name of await caches.keys()) {
      if (name.indexOf(PREFIX) !== 0) {
        continue;
      }
      const cache = await caches.open(name);
      const saved = await cache.match(META);
      const meta = saved ? await saved.json().catch(() => null) : null;
      if (meta && (!best || String(meta.savedAt) > String(best.meta.savedAt))) {
        best = { name, cache, meta };
      }
    }
    return best;
  }

  // no-store: straight from the web server, never the copy (see sw.js)
  async function fromServer(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(url + " answered " + response.status);
    }
    return response;
  }

  async function serverManifest() {
    const manifest = await (await fromServer(MANIFEST)).json();
    if (
      !manifest ||
      typeof manifest.build !== "string" ||
      !manifest.files ||
      typeof manifest.files !== "object"
    ) {
      throw new Error("offline-manifest.json is not a list of files");
    }
    return manifest;
  }

  // The translations to keep: the languages this browser asks for, English,
  // and whatever the copy already had. "pt-BR" also means "pt_BR" and "pt".
  function languagesToKeep(manifest, previous) {
    const offered = manifest.languages || [];
    const wanted = ["en"].concat(previous || []);
    for (const tag of navigator.languages || [navigator.language || "en"]) {
      const text = String(tag);
      wanted.push(text, text.split("-").join("_"), text.split(/[-_]/)[0]);
    }
    return offered.filter((language) => wanted.indexOf(language) !== -1);
  }

  // Tell the service worker the copy changed, and wait until it has heard.
  async function tellServiceWorker() {
    const registration =
      navigator.serviceWorker && (await navigator.serviceWorker.ready);
    const worker = registration && registration.active;
    if (!worker) {
      return;
    }
    await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = resolve;
      setTimeout(resolve, 2000);
      worker.postMessage({ type: "haxcms-offline-changed" }, [channel.port2]);
    });
  }

  // Save the build the web server has now. Files the copy in use already
  // holds unchanged are taken from it, so an update only downloads what is
  // new. Resolves the new copy's meta record.
  async function saveCopy(onProgress) {
    const manifest = await serverManifest();
    if (manifest.format !== FORMAT) {
      throw new Error(
        "this page is older than the site on the web; reload it and try again",
      );
    }
    const previous = await currentCopy();
    const languages = languagesToKeep(
      manifest,
      previous ? previous.meta.languages : [],
    );
    const files = Object.assign({}, manifest.files);
    for (const language of languages) {
      const list = await (
        await fromServer(LOCALES + language + ".json")
      ).json();
      Object.assign(files, list.files);
    }
    const paths = Object.keys(files);
    const bytes = paths.reduce((sum, path) => sum + files[path][1], 0);

    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate().catch(() => null);
      if (
        estimate &&
        estimate.quota &&
        estimate.quota - (estimate.usage || 0) < bytes * 1.2
      ) {
        throw new Error(
          "this browser does not have room for it (" +
            megabytes(bytes) +
            " needed)",
        );
      }
    }

    const name = PREFIX + manifest.build;
    const reuse =
      previous && previous.name !== name
        ? { cache: previous.cache, files: {} }
        : null;
    if (reuse) {
      const saved = await previous.cache.match(FILES);
      reuse.files = saved ? await saved.json().catch(() => ({})) : {};
    }
    if (!previous || previous.name !== name) {
      // a save of this build that stopped part way
      await caches.delete(name);
    }
    const cache = await caches.open(name);

    let done = 0;
    let doneBytes = 0;
    let next = 0;
    async function one(path) {
      const address = new URL(path, base).href;
      if (address.indexOf(base) !== 0) {
        throw new Error(path + " is not a file of this site");
      }
      const expected = files[path];
      if (previous && previous.name === name && (await cache.match(address))) {
        return; // same build: only fill in what is missing
      }
      let response = null;
      if (reuse && reuse.files[path] && reuse.files[path][0] === expected[0]) {
        response = await reuse.cache.match(address);
      }
      if (!response) {
        const fetched = await fromServer(address);
        const body = await fetched.blob();
        if (body.size !== expected[1]) {
          throw new Error(path + " did not arrive whole");
        }
        response = new Response(body, {
          headers: {
            "content-type":
              fetched.headers.get("content-type") || "application/octet-stream",
          },
        });
      }
      await cache.put(address, response);
    }
    async function worker() {
      while (next < paths.length) {
        const path = paths[next++];
        await one(path);
        done += 1;
        doneBytes += files[path][1];
        onProgress({ done, total: paths.length, doneBytes, bytes });
      }
    }
    try {
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      // a deploy while this ran would leave two builds mixed together
      const after = await serverManifest();
      if (after.build !== manifest.build) {
        throw new Error("the site was updated while it was being saved");
      }
    } catch (error) {
      next = paths.length; // stop the other downloads
      if (!previous || previous.name !== name) {
        await caches.delete(name);
      }
      throw error;
    }
    const meta = {
      format: FORMAT,
      build: manifest.build,
      savedAt: new Date().toISOString(),
      files: paths.length,
      bytes,
      languages,
    };
    await cache.put(FILES, jsonResponse(files));
    await cache.put(META, jsonResponse(meta)); // last: now it is a copy
    for (const other of await caches.keys()) {
      if (other.indexOf(PREFIX) === 0 && other !== name) {
        await caches.delete(other);
      }
    }
    await tellServiceWorker();
    return meta;
  }

  async function removeCopy() {
    for (const name of await caches.keys()) {
      if (name.indexOf(PREFIX) === 0) {
        await caches.delete(name);
      }
    }
    await tellServiceWorker();
  }

  function isInstalled() {
    return (
      (globalThis.matchMedia &&
        globalThis.matchMedia("(display-mode: standalone)").matches) ||
      navigator.standalone === true
    );
  }

  // "Not now" on the install offer, remembered in this browser
  const OFFER_KEY = "haxcms-browser:install-offer-dismissed";
  const OFFER_QUIET_MS = 14 * 24 * 60 * 60 * 1000;
  function offerDismissedRecently() {
    try {
      const when = Number(globalThis.localStorage.getItem(OFFER_KEY));
      return !!when && Date.now() - when < OFFER_QUIET_MS;
    } catch (e) {
      return false;
    }
  }
  function dismissOffer() {
    try {
      globalThis.localStorage.setItem(OFFER_KEY, String(Date.now()));
    } catch (e) {
      // storage can be off; the offer then comes back next time
    }
  }

  function isAppleTouch() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    );
  }

  globalThis.HaxcmsOffline = function HaxcmsOffline(options) {
    const toast = options.toast;
    const state = byId("offline-state");
    const progress = byId("offline-progress");
    const storageState = byId("storage-state");
    const installHelp = byId("install-help");
    const installButton = byId("install-button");
    const saveButton = byId("offline-save");
    const updateButton = byId("offline-update");
    const removeButton = byId("offline-remove");

    const supported = !!globalThis.caches && "serviceWorker" in navigator;
    let copy = null; // meta of the copy in this browser
    let newer = false; // the web server has a different build
    let busy = false;
    let installPrompt = null;
    let lastCheck = 0;
    let offered = ""; // the build the update notice was last shown for
    let installOffered = false; // the install notice was shown this load

    // Offer to install, once per load, unless another notice is up (an
    // update notice matters more) or the person said not now recently.
    function offerInstall() {
      if (
        installOffered ||
        isInstalled() ||
        offerDismissedRecently() ||
        !byId("toast").hidden
      ) {
        return;
      }
      if (installPrompt) {
        installOffered = true;
        toast({
          text: "Install HAX as an app? It opens in its own window, works without a connection, and the browser keeps your sites safe.",
          action: "Install",
          run: () => installButton.click(),
          dismiss: "Not now",
          onDismiss: dismissOffer,
        });
      } else if (isAppleTouch() && supported) {
        installOffered = true;
        toast({
          text: "Install HAX as an app: tap Share, then Add to Home Screen. It then works without a connection and keeps your sites safe.",
          dismiss: "Got it",
          onDismiss: dismissOffer,
        });
      }
    }

    function show(text) {
      state.textContent = text;
    }

    function render() {
      if (!supported) {
        show("This browser cannot keep HAX for offline use.");
      } else if (busy) {
        // the progress line is on screen
      } else if (copy) {
        show(
          "HAX works offline in this browser. The copy was saved " +
            new Date(copy.savedAt).toLocaleDateString() +
            " (" +
            megabytes(copy.bytes) +
            ")." +
            (newer ? " A newer version is available." : ""),
        );
      } else {
        show(
          "HAX is loading from the web each time. Install it, or make it available offline, to open it without a connection.",
        );
      }
      progress.hidden = !busy;
      saveButton.hidden = !supported || busy || !!copy;
      updateButton.hidden = busy || !copy || !newer;
      removeButton.hidden = busy || !copy;
      installButton.hidden = !installPrompt;
      installHelp.hidden = !(isAppleTouch() && !isInstalled());
    }

    // Storage this browser will not clear on its own is what keeps sites
    // safe; installing is the surest way to get it (Safari clears a site it
    // has not seen for a week unless it is on the home screen).
    async function showStorage(ask) {
      if (!navigator.storage || !navigator.storage.persisted) {
        storageState.textContent = "";
        return;
      }
      let kept = await navigator.storage.persisted().catch(() => false);
      if (!kept && ask && navigator.storage.persist) {
        kept = await navigator.storage.persist().catch(() => false);
      }
      storageState.textContent = kept
        ? "This browser will keep what is saved here until you remove it."
        : "This browser may clear what is saved here if it runs low on space or you do not visit for a while. Installing HAX, or saving to a folder, protects your sites.";
    }

    async function save(reason) {
      if (busy || !supported) {
        return;
      }
      busy = true;
      progress.value = 0;
      show("Saving HAX for offline use…");
      render();
      try {
        copy = await saveCopy((at) => {
          progress.value = Math.round((at.doneBytes / at.bytes) * 100);
          show(
            "Saving HAX for offline use: " +
              megabytes(at.doneBytes) +
              " of " +
              megabytes(at.bytes) +
              "…",
          );
        });
        busy = false;
        const updated = newer || reason === "update";
        newer = false;
        render();
        showStorage(true);
        if (updated) {
          toast({
            text: "The newer version of HAX is saved. Reload to start using it. Your sites stay as they are.",
            action: "Reload now",
            run: () => globalThis.location.reload(),
            dismiss: "Later",
          });
        } else {
          toast({
            text: "HAX is ready to work offline in this browser.",
            dismiss: "OK",
          });
        }
      } catch (error) {
        busy = false;
        render();
        show(
          "HAX could not be saved for offline use: " +
            String((error && error.message) || error) +
            ". " +
            (copy
              ? "The copy you already have is unchanged."
              : "Nothing was kept."),
        );
        console.warn("[haxcms-browser] offline copy", error);
      }
    }

    async function remove() {
      if (busy) {
        return;
      }
      await removeCopy();
      copy = null;
      newer = false;
      offered = "";
      render();
      show(
        "The offline copy was removed. HAX loads from the web again, starting with the next reload. Your sites were not touched.",
      );
    }

    // Is the web server's build the one saved here? Quietly does nothing
    // with no copy or no connection.
    async function check(force) {
      if (!supported || busy || !copy) {
        return;
      }
      if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) {
        return;
      }
      lastCheck = Date.now();
      let manifest;
      try {
        manifest = await serverManifest();
      } catch (e) {
        return; // offline, or the server is out: the copy is what there is
      }
      if (manifest.format !== FORMAT) {
        // the site now keeps copies another way: its service worker drops
        // this one, and the next load comes from the web server
        return;
      }
      newer = manifest.build !== copy.build;
      render();
      if (newer && offered !== manifest.build) {
        offered = manifest.build;
        toast({
          text:
            "A newer version of HAX is available. This browser is using the offline copy saved " +
            new Date(copy.savedAt).toLocaleDateString() +
            ".",
          action: "Update",
          run: () => save("update"),
          dismiss: "Not now",
        });
      }
    }

    saveButton.addEventListener("click", () => save("asked"));
    updateButton.addEventListener("click", () => save("update"));
    removeButton.addEventListener("click", () => {
      remove().catch((error) => show("Could not remove it: " + String(error)));
    });
    installButton.addEventListener("click", () => {
      const prompt = installPrompt;
      installPrompt = null;
      render();
      if (prompt) {
        prompt.prompt();
      }
    });
    // Chromium says the page can be installed with this event. It is kept
    // for the notice and the button, which replace the browser's own banner.
    globalThis.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      render();
      offerInstall();
    });
    // installed: an app is expected to open without a connection
    globalThis.addEventListener("appinstalled", () => {
      installPrompt = null;
      render();
      if (!copy) {
        save("installed");
      }
    });
    globalThis.addEventListener("online", () => check(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        check(false);
      }
    });

    return {
      async start() {
        render();
        if (!supported) {
          return;
        }
        copy = await currentCopy()
          .then((found) => (found ? found.meta : null))
          .catch(() => null);
        render();
        showStorage(isInstalled() || !!copy);
        if (!copy && isInstalled()) {
          // installed where no event says so (iOS home screen)
          save("installed");
        } else {
          check(true);
        }
        offerInstall();
      },
      // for the details panel and tests
      state: () => ({ copy, newer, busy }),
    };
  };
})();
