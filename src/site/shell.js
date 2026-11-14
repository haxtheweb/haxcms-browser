/**
 * Host page for HAXcms in the browser (haxtheweb/issues#3331).
 *
 * This page owns the Worker that runs haxcms-nodejs, and shows HAXcms in an
 * iframe mounted at ./app/<session>/. The service worker (sw.js) sends every
 * request those iframe pages make back to this page, which passes it to the
 * Worker and returns the answer. Because the Worker belongs to this page,
 * HAXcms keeps running while the iframe moves between the dashboard and
 * sites.
 *
 * It also decides where sites are saved, and says so in the bar:
 *   a folder on this computer   the user picked it ("Save to a folder");
 *                               each site is a normal HAXsite folder in it
 *   this browser                the browser's private file system for this
 *                               page; the default, one tab at a time
 *   the cloud                   Google Drive, OneDrive, Dropbox, Box or a
 *                               WebDAV server ("Save to the cloud",
 *                               accounts.js; runtime/remote.cjs); the
 *                               choice is remembered, the sign-in lasts
 *                               until the tab closes
 *   nowhere (memory only)       when neither is possible; gone on reload
 * The Worker loads the sites from there on start and writes every change
 * back before it answers the request that made it (see runtime/worker.cjs).
 *
 * Publish (publish.js) puts a site on the web through this deployment's
 * publish broker (api/), or straight to hosts people sign in to.
 *
 * Sign in (accounts.js, auth.js): when someone has signed in, each site
 * they make gets their name, email and picture as its author, set through
 * HAXcms's own SEO settings route right after the site is created.
 */
(function () {
  "use strict";

  const statusText = document.getElementById("status");
  const dot = document.getElementById("dot");
  const note = document.getElementById("note");
  const frame = document.getElementById("app");
  const message = document.getElementById("message");
  const detailsButton = document.getElementById("details-button");
  const details = document.getElementById("details");
  const detailsList = document.getElementById("details-list");
  const folderButton = document.getElementById("folder-button");
  const reopenButton = document.getElementById("reopen-button");
  const browserButton = document.getElementById("browser-button");
  const cloudButton = document.getElementById("cloud-button");

  const scope = new URL("./", globalThis.location.href).pathname;
  // one random id per host page, so two tabs never answer for each other
  const session = Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(8)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const mount = scope + "app/" + session + "/";

  const RUNNING = "HAXcms is running in your browser";
  const NOT_SAVED = "Not saved: your last change did not reach storage";
  const BROWSER_STORE = "haxcms-sites";
  const BROWSER_LOCK = "haxcms-browser:browser-storage";
  // the cloud storage last used (no secrets): { provider, label, webdav: { url, username } }
  const CLOUD_CHOICE = "haxcms-browser:cloud";
  const canPickFolder = typeof globalThis.showDirectoryPicker === "function";

  // where sites are saved:
  // { kind: "folder" | "browser" | "cloud" | "memory", handle, remote, label, reason }
  let storage = { kind: "memory", handle: null, reason: "" };
  // a folder used before that needs the user's go-ahead to open again
  let remembered = null;
  // cloud storage used before that needs signing in again
  let rememberedCloud = null;
  let snapshot = null;
  let version = {};
  let running = false;
  const auth = globalThis.HaxcmsAuth();
  const publisher = globalThis.HaxcmsPublish({
    send,
    isRunning: () => running,
    auth,
  });
  const accounts = globalThis.HaxcmsAccounts({
    auth,
    isRunning: () => running,
    useCloud,
  });
  // the last change could not be written to storage
  let saveProblem = false;

  function setStatus(text, state) {
    statusText.textContent = text;
    dot.dataset.state = state || "";
  }

  function fail(title, error) {
    running = false;
    publisher.show(false);
    accounts.show(false);
    setStatus("HAXcms could not start", "error");
    frame.hidden = true;
    message.hidden = false;
    message.textContent = "";
    const heading = document.createElement("h1");
    heading.textContent = title;
    const text = document.createElement("pre");
    text.textContent = String((error && error.stack) || error || "");
    message.append(heading, text);
  }

  // a short notice in the page, for things the user asked for that did not
  // happen (the wrong kind of folder, permission not given)
  let noticeTimer = null;
  function notify(text) {
    note.textContent = text;
    note.dataset.state = "notice";
    clearTimeout(noticeTimer);
    // then go back to saying where sites are saved
    noticeTimer = setTimeout(() => {
      if (running) {
        showStorage();
      }
    }, 15000);
  }

  // what the runtime could not load, as the features people know
  const FEATURES = {
    "git-interface": "revisions (git history)",
    "puppeteer-core": "PDF export",
    "html-to-docx": "Word export",
    "epub-gen-memory": "EPUB export",
    mammoth: "Word import",
    unpdf: "PDF import",
    "text-readability": "readability scores",
  };

  function unavailableFeatures(names) {
    const features = (names || [])
      .filter((name) => Object.prototype.hasOwnProperty.call(FEATURES, name))
      .map((name) => FEATURES[name]);
    return features.length ? features.join(", ") : "nothing";
  }

  function showDetailsPanel(open) {
    details.hidden = !open;
    detailsButton.setAttribute("aria-expanded", String(open));
  }
  detailsButton.addEventListener("click", () => {
    showDetailsPanel(details.hidden);
  });
  // Escape closes Details from inside it, back on the button that opened it
  details.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      showDetailsPanel(false);
      detailsButton.focus();
    }
  });

  // --- where sites are saved ---------------------------------------------

  function storageSentence() {
    if (storage.kind === "folder") {
      return (
        'Saving to the folder "' +
        storage.handle.name +
        '" on this computer. Nothing is sent to a server.'
      );
    }
    if (storage.kind === "cloud") {
      return (
        "Saving to " +
        storage.label +
        (storage.remote.provider === "webdav"
          ? "."
          : ', in a "HAXcms sites" folder there.')
      );
    }
    if (storage.kind === "browser") {
      return (
        "Saved in this browser, on this computer. Browsers can clear this storage when space runs low: " +
        (canPickFolder
          ? "save to a folder or the cloud to keep your sites."
          : "save to the cloud to keep your sites.")
      );
    }
    return (
      "Not being saved: " +
      (storage.reason || "this browser has no storage this page can use") +
      ". Sites made here are gone when you reload or close this tab."
    );
  }

  function showStorage() {
    note.textContent = storageSentence();
    note.dataset.state = storage.kind === "memory" ? "warning" : "";
    folderButton.hidden = !canPickFolder;
    folderButton.textContent =
      storage.kind === "folder" ? "Change folder" : "Save to a folder";
    browserButton.hidden =
      storage.kind !== "folder" && storage.kind !== "cloud";
    browserButton.textContent =
      storage.kind === "cloud"
        ? "Stop using " + storage.label
        : "Stop using the folder";
    cloudButton.textContent =
      storage.kind === "cloud" ? "Change cloud storage" : "Save to the cloud";
    if (rememberedCloud && storage.kind !== "cloud") {
      reopenButton.hidden = false;
      reopenButton.textContent = "Reconnect " + rememberedCloud.label;
    } else {
      reopenButton.hidden = !(remembered && storage.kind !== "folder");
      if (remembered) {
        reopenButton.textContent = 'Reopen folder "' + remembered.name + '"';
      }
    }
  }

  // --- cloud storage ---------------------------------------------------
  function loadCloudChoice() {
    try {
      const value = JSON.parse(
        globalThis.localStorage.getItem(CLOUD_CHOICE) || "null",
      );
      return value && typeof value.provider === "string" ? value : null;
    } catch (e) {
      return null;
    }
  }

  function saveCloudChoice(choice) {
    try {
      if (choice) {
        globalThis.localStorage.setItem(
          CLOUD_CHOICE,
          JSON.stringify({
            provider: choice.remote.provider,
            label: choice.label,
            webdav: choice.remote.webdav
              ? {
                  url: choice.remote.webdav.url,
                  username: choice.remote.webdav.username,
                }
              : null,
          }),
        );
      } else {
        globalThis.localStorage.removeItem(CLOUD_CHOICE);
      }
    } catch (e) {
      // storage can be off: the choice then lasts until reload
    }
  }

  // the remembered cloud choice as a storage, if it can be used without
  // asking (still signed in in this tab); null otherwise
  function cloudFromChoice(choice) {
    if (!choice) {
      return null;
    }
    if (choice.provider === "webdav") {
      // the app password is never stored: reconnecting asks for it again
      return null;
    }
    if (!auth.signedIn(choice.provider)) {
      return null;
    }
    return {
      kind: "cloud",
      remote: { provider: choice.provider },
      label: choice.label,
      reason: "",
    };
  }

  // Move HAXcms onto cloud storage (accounts.js calls this once signed in).
  // Empty there: the sites open now are copied in. Sites there already:
  // HAXcms starts again from them, like opening a folder of sites.
  async function useCloud(choice) {
    const chosen = {
      kind: "cloud",
      remote: choice.remote,
      label: choice.label,
      reason: "",
    };
    const inspected = await send("inspectRemote", { remote: choice.remote });
    saveCloudChoice(chosen);
    rememberedCloud = null;
    await forgetFolder();
    remembered = null;
    if (inspected.entries === 0 && running) {
      setStatus("Saving your sites to " + choice.label + "…", "");
      await send("useStorage", { remote: choice.remote });
      storage = chosen;
      setStatus(RUNNING, "ready");
      showStorage();
      showDetails();
      return;
    }
    try {
      await restart(chosen);
    } catch (error) {
      // don't leave HAXcms stopped: back to this browser's storage
      saveCloudChoice(null);
      await restart(await browserStorage());
      throw error;
    }
  }

  // Answer the Worker's requests for a sign-in token (cloud storage).
  function answerTokenRequest(data) {
    auth
      .token(data.provider, data.force)
      .catch(() => null)
      .then((token) => {
        if (worker) {
          worker.postMessage({
            type: "token-reply",
            requestId: data.requestId,
            token: token || "",
          });
        }
      });
  }

  // The folder last used is remembered in this browser (IndexedDB can hold a
  // folder handle), so coming back is one click instead of picking it again.
  function handleStore(mode, work) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("haxcms-browser", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("handles");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction("handles", mode);
        const request = work(transaction.objectStore("handles"));
        transaction.oncomplete = () => {
          db.close();
          resolve(request ? request.result : undefined);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      };
    });
  }
  const recallFolder = () =>
    handleStore("readonly", (store) => store.get("folder")).catch(() => null);
  const rememberFolder = (handle) =>
    handleStore("readwrite", (store) => store.put(handle, "folder")).catch(
      () => {},
    );
  const forgetFolder = () =>
    handleStore("readwrite", (store) => store.delete("folder")).catch(() => {});

  async function permission(handle, ask) {
    const options = { mode: "readwrite" };
    if (ask && typeof handle.requestPermission === "function") {
      return handle.requestPermission(options);
    }
    if (typeof handle.queryPermission === "function") {
      return handle.queryPermission(options);
    }
    return "granted";
  }

  // Browser storage is used by one tab at a time: two runtimes writing the
  // same files would undo each other. The lock is held until the tab closes.
  let browserLock = null;
  function holdBrowserLock() {
    if (browserLock) {
      return browserLock;
    }
    if (!navigator.locks) {
      browserLock = Promise.resolve(true);
      return browserLock;
    }
    browserLock = new Promise((resolve) => {
      navigator.locks
        .request(BROWSER_LOCK, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          // keep it for as long as this page lives
          return lock ? new Promise(() => {}) : undefined;
        })
        .catch(() => resolve(false));
    });
    return browserLock;
  }

  async function browserStorage() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      return {
        kind: "memory",
        handle: null,
        reason: "this browser has no storage this page can use",
      };
    }
    if (!(await holdBrowserLock())) {
      return {
        kind: "memory",
        handle: null,
        reason:
          "HAXcms is already open in another tab, which is the one saving",
      };
    }
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getDirectoryHandle(BROWSER_STORE, {
        create: true,
      });
      if (navigator.storage.persist) {
        // ask the browser not to clear this page's storage when space is short
        navigator.storage.persist().catch(() => {});
      }
      return { kind: "browser", handle, reason: "" };
    } catch (error) {
      return {
        kind: "memory",
        handle: null,
        reason: "this browser would not open its storage for this page",
      };
    }
  }

  async function chooseStorage() {
    const cloudChoice = loadCloudChoice();
    if (cloudChoice) {
      const cloud = cloudFromChoice(cloudChoice);
      if (cloud) {
        return cloud;
      }
      // sign in again first; meanwhile this browser's storage
      rememberedCloud = cloudChoice;
    }
    remembered = await recallFolder();
    if (remembered && (await permission(remembered, false)) === "granted") {
      return { kind: "folder", handle: remembered, reason: "" };
    }
    return browserStorage();
  }

  // What is in a folder the user picked: "empty", "sites" (every folder in it
  // is a HAXsite), "site" (it is itself one HAXsite) or "other".
  async function inspectFolder(handle) {
    let sites = 0;
    for await (const [name, entry] of handle.entries()) {
      if (name.charAt(0) === ".") {
        continue;
      }
      if (entry.kind === "file") {
        return name === "site.json" ? "site" : "other";
      }
      const isSite = await entry
        .getFileHandle("site.json")
        .then(() => true)
        .catch(() => false);
      if (!isSite) {
        return "other";
      }
      sites += 1;
    }
    return sites ? "sites" : "empty";
  }

  async function useFolder(handle) {
    if ((await permission(handle, true)) !== "granted") {
      notify("HAXcms was not given permission to save to that folder.");
      return;
    }
    const contents = await inspectFolder(handle);
    if (contents === "site") {
      notify(
        'The folder "' +
          handle.name +
          '" is a single HAX site. Pick the folder it sits in, so HAXcms can keep each site in its own folder there.',
      );
      return;
    }
    if (contents === "other") {
      notify(
        'The folder "' +
          handle.name +
          '" has other things in it. Pick an empty folder, or one that only holds HAX sites.',
      );
      return;
    }
    await rememberFolder(handle);
    remembered = handle;
    saveCloudChoice(null);
    rememberedCloud = null;
    if (contents === "empty" && running) {
      // keep working: the sites open now are written into the new folder
      setStatus("Saving your sites to the folder…", "");
      await send("useStorage", { handle });
      storage = { kind: "folder", handle, reason: "" };
      setStatus(RUNNING, "ready");
      showStorage();
      showDetails();
      return;
    }
    // the folder already holds sites: start HAXcms again from it
    await restart({ kind: "folder", handle, reason: "" });
  }

  folderButton.addEventListener("click", () => {
    globalThis
      .showDirectoryPicker({ mode: "readwrite", id: "haxcms-sites" })
      .then(useFolder)
      .catch((error) => {
        if (!error || error.name !== "AbortError") {
          notify("That folder could not be opened. " + String(error));
        }
      });
  });
  reopenButton.addEventListener("click", () => {
    if (rememberedCloud && storage.kind !== "cloud") {
      const choice = rememberedCloud;
      if (choice.provider === "webdav") {
        // the app password isn't remembered: ask for it again
        accounts.prefillWebdav(choice.webdav);
        return;
      }
      // straight from the click, so the sign-in popup isn't blocked
      auth
        .signIn(choice.provider)
        .then(() =>
          useCloud({
            remote: { provider: choice.provider },
            label: choice.label,
          }),
        )
        .catch((error) =>
          notify(
            "Could not reconnect " +
              choice.label +
              ". " +
              String((error && error.message) || error),
          ),
        );
      return;
    }
    useFolder(remembered).catch((error) =>
      notify("That folder could not be opened. " + String(error)),
    );
  });
  browserButton.addEventListener("click", () => {
    saveCloudChoice(null);
    rememberedCloud = null;
    forgetFolder()
      .then(() => {
        remembered = null;
        return browserStorage();
      })
      .then(restart)
      .catch((error) => fail("HAXcms could not start", error));
  });

  // --- the Worker that runs haxcms-nodejs ------------------------------
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function send(type, args, transfer) {
    return new Promise((resolve, reject) => {
      if (!worker) {
        reject(new Error("HAXcms is restarting"));
        return;
      }
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id, type }, args), transfer || []);
    });
  }

  function startWorker() {
    worker = new Worker("./haxcms-worker.js");
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "token-request") {
        answerTokenRequest(data);
        return;
      }
      const waiting = pending.get(data.id);
      if (!waiting) {
        return;
      }
      pending.delete(data.id);
      if (data.ok) {
        waiting.resolve(data.result);
      } else {
        waiting.reject(new Error(data.error));
      }
    };
    worker.onerror = (event) => {
      fail("The HAXcms runtime stopped", event.message);
    };
  }

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    for (const waiting of pending.values()) {
      waiting.reject(new Error("HAXcms is restarting"));
    }
    pending.clear();
  }

  // --- cookies -----------------------------------------------------------
  // A service worker cannot set real cookies on the responses it builds, and
  // HAXcms keeps the signed-in session in one. So this page keeps the
  // session's cookies itself, in memory: it remembers what the runtime sets
  // and sends it back on later requests, as a browser would.
  const cookies = new Map();

  function rememberCookies(headers) {
    const setCookie = headers && headers["set-cookie"];
    if (!setCookie) {
      return;
    }
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const parts = String(line).split(";");
      const pair = parts[0];
      const equals = pair.indexOf("=");
      if (equals < 1) {
        continue;
      }
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      let expired = value === "";
      for (const attribute of parts.slice(1)) {
        const [key, attributeValue] = attribute.trim().split("=");
        if (/^max-age$/i.test(key) && Number(attributeValue) <= 0) {
          expired = true;
        }
        if (
          /^expires$/i.test(key) &&
          Date.parse(attributeValue) <= Date.now()
        ) {
          expired = true;
        }
      }
      if (expired) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
    delete headers["set-cookie"];
  }

  function cookieHeader() {
    return Array.from(cookies, ([name, value]) => name + "=" + value).join(
      "; ",
    );
  }

  // --- the signed-in person as the author of new sites -------------------
  // Right after HAXcms makes a site, the author from the sign-in is saved
  // through the same route the site editor's SEO settings use
  // (PATCH x/api/v1/site/seo), with the site token HAXcms gives that site.
  function decodeBody(body) {
    if (!body) {
      return "";
    }
    return new TextDecoder().decode(
      body instanceof ArrayBuffer ? new Uint8Array(body) : body,
    );
  }

  function appSettingsFrom(script) {
    const start = script.indexOf("window.appSettings =");
    if (start === -1) {
      return null;
    }
    const rest = script.slice(start + "window.appSettings =".length);
    // the settings are one JSON object, followed by ";" and maybe the jwt line
    const jwtLine = rest.indexOf(";window.appSettings.jwt");
    const json = (jwtLine === -1 ? rest : rest.slice(0, jwtLine)).replace(
      /;\s*$/,
      "",
    );
    let settings;
    try {
      settings = JSON.parse(json);
    } catch (e) {
      return null;
    }
    const jwt = /window\.appSettings\.jwt = "([^"]*)"/.exec(rest);
    if (jwt && !settings.jwt) {
      settings.jwt = jwt[1];
    }
    return settings;
  }

  async function applyAuthor(siteName) {
    const identity = auth.identity();
    if (!identity || !(identity.name || identity.email)) {
      return;
    }
    const settingsResponse = await send("request", {
      method: "GET",
      url: "/system/api/v1/session/connection-settings",
      headers: {
        accept: "application/javascript",
        referer:
          globalThis.location.origin + mount + "_sites/" + siteName + "/",
        cookie: cookieHeader(),
      },
      binary: true,
    });
    const settings = appSettingsFrom(decodeBody(settingsResponse.body));
    if (!settings || !settings.siteToken) {
      return;
    }
    const author = {};
    if (identity.name) {
      author.name = identity.name;
    }
    if (identity.email) {
      author.email = identity.email;
    }
    if (/^https:\/\//.test(identity.image || "")) {
      author.image = identity.image;
    }
    const headers = {
      "content-type": "application/json",
      "x-haxcms-site-token": settings.siteToken,
      origin: globalThis.location.origin,
      cookie: cookieHeader(),
    };
    if (settings.jwt) {
      headers.authorization = "Bearer " + settings.jwt;
    }
    const saved = await send("request", {
      method: "PATCH",
      url: "/_sites/" + siteName + "/x/api/v1/site/seo",
      headers,
      body: new TextEncoder().encode(
        JSON.stringify({ site: { name: siteName }, author }),
      ).buffer,
      binary: true,
    });
    if (saved.status !== 200) {
      console.warn(
        "[haxcms-browser] the author could not be filled in (" +
          saved.status +
          ")",
      );
    }
  }

  // the site a successful create-site response is for, or ""
  function createdSite(request, response) {
    if (
      request.method !== "POST" ||
      !/\/system\/api\/v1\/sites\/?$/.test(String(request.url).split("?")[0]) ||
      response.status !== 200
    ) {
      return "";
    }
    try {
      const body = JSON.parse(decodeBody(response.body));
      const link = String((body && body.link) || "");
      const match = /\/_sites\/([^/]+)\/?$/.exec(link);
      return match ? decodeURIComponent(match[1]) : "";
    } catch (e) {
      return "";
    }
  }

  // --- requests relayed by the service worker --------------------------
  function onServiceWorkerMessage(event) {
    // only this origin's service worker can reach this listener
    if (event.origin && event.origin !== globalThis.location.origin) {
      return;
    }
    const data = event.data || {};
    if (data.type !== "haxcms-request" || data.session !== session) {
      return; // another tab's session: that tab answers
    }
    const port = event.ports[0];
    port.postMessage({ ack: true });
    const request = Object.assign({}, data.request, { binary: true });
    request.headers = Object.assign({}, request.headers);
    if (cookies.size) {
      request.headers.cookie = cookieHeader();
    }
    send("request", request, request.body ? [request.body] : [])
      .then(async (response) => {
        rememberCookies(response.headers);
        const newSite = createdSite(request, response);
        if (newSite) {
          // before answering, so the dashboard opens the site with its author
          await applyAuthor(newSite).catch((error) =>
            console.warn("[haxcms-browser]", error),
          );
        }
        if (response.saveFailed) {
          // HAXcms shows its own error; the bar says why, until a later
          // change is saved
          saveProblem = true;
          setStatus(NOT_SAVED, "error");
        } else if (
          saveProblem &&
          !/^(GET|HEAD|OPTIONS)$/.test(request.method)
        ) {
          saveProblem = false;
          setStatus(RUNNING, "ready");
        }
        port.postMessage({ response }, response.body ? [response.body] : []);
      })
      .catch((error) => {
        console.error("[haxcms-browser]", error);
        port.postMessage({ error: String((error && error.message) || error) });
      });
  }

  async function registerServiceWorker() {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
    });
    await navigator.serviceWorker.ready;
    return registration;
  }

  async function loadJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(url + " answered " + response.status);
    }
    return response.json();
  }

  // --- starting (and restarting) HAXcms ---------------------------------
  let lastBoot = null;

  function showDetails() {
    detailsList.textContent = "";
    const add = (label, value) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      // each pair is a tile: a div is the one wrapper a dl allows
      const row = document.createElement("div");
      row.append(term, description);
      detailsList.append(row);
    };
    if (lastBoot) {
      add(
        "Running",
        "haxcms-nodejs in this browser tab (" +
          lastBoot.mode +
          " mode), started in " +
          lastBoot.seconds +
          " s",
      );
    }
    add(
      "Saving to",
      storage.kind === "folder"
        ? 'The folder "' +
            storage.handle.name +
            '" on this computer. Each site is its own folder in it.'
        : storage.kind === "cloud"
          ? storage.label +
            (storage.remote.provider === "webdav"
              ? ", at " + storage.remote.webdav.url
              : ', in the "HAXcms sites" folder HAXcms made there') +
            ". Each site is its own folder in it."
          : storage.kind === "browser"
            ? "This browser's storage for this page. Clearing site data for this page removes it."
            : "Nowhere: " + storage.reason,
    );
    if (lastBoot) {
      add("Not available here", unavailableFeatures(lastBoot.unavailable));
    }
    add(
      "Build",
      "haxcms-browser " +
        (version.haxcmsBrowser || "local") +
        ", haxcms-nodejs " +
        (version.haxcmsNodejs || "local") +
        (version.built ? ", " + version.built : ""),
    );
  }

  async function boot(chosen) {
    const began = performance.now();
    storage = chosen;
    startWorker();
    const booted = await send("boot", {
      snapshot,
      root: "/haxcms",
      basePath: mount,
      origin: globalThis.location.origin,
      storage: storage.remote
        ? { remote: storage.remote }
        : storage.handle
          ? { handle: storage.handle }
          : null,
    });
    // one local user, so sign in for them: HAXcms then opens signed in
    const signedIn = await send("signIn", {});
    if (signedIn.status !== 200) {
      throw new Error(
        "could not sign in the local user (" + signedIn.status + ")",
      );
    }
    rememberCookies(signedIn.headers);
    lastBoot = {
      mode: booted.mode,
      unavailable: booted.unavailable,
      seconds: ((performance.now() - began) / 1000).toFixed(1),
    };
    running = true;
    publisher.show(true);
    accounts.show(true);
    showStorage();
    showDetails();
    message.hidden = true;
    frame.hidden = false;
    if (frame.getAttribute("src")) {
      frame.contentWindow.location.replace(mount);
    } else {
      frame.src = mount;
    }
  }

  // Take the HAXcms page out of the frame and wait until it is gone. A page
  // left open across a restart keeps asking for things: its requests fail
  // while HAXcms is down, it signs itself out, and that sign-out lands on
  // the HAXcms that has just started (the user then meets a sign-in form).
  function emptyFrame() {
    if (!frame.getAttribute("src")) {
      return Promise.resolve();
    }
    frame.hidden = true;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      frame.contentWindow.location.replace("about:blank");
    });
  }

  async function restart(chosen) {
    running = false;
    publisher.show(false);
    accounts.show(false);
    saveProblem = false;
    setStatus("Starting HAXcms in your browser…", "");
    await emptyFrame();
    stopWorker();
    cookies.clear();
    await boot(chosen);
  }

  async function start() {
    if (!("serviceWorker" in navigator) || !globalThis.Worker) {
      fail(
        "This browser can't run HAXcms in a tab",
        "It needs service workers and web workers. Private windows in some browsers turn service workers off.",
      );
      return;
    }
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    frame.addEventListener("load", () => {
      if (running) {
        setStatus(
          saveProblem ? NOT_SAVED : RUNNING,
          saveProblem ? "error" : "ready",
        );
      }
    });
    const loaded = await Promise.all([
      registerServiceWorker(),
      loadJson("./haxcms-snapshot.json"),
      loadJson("./version.json").catch(() => ({})),
      chooseStorage(),
    ]);
    snapshot = loaded[1];
    version = loaded[2];
    try {
      await boot(loaded[3]);
    } catch (error) {
      if (loaded[3].kind === "cloud") {
        console.warn("[haxcms-browser]", error);
        rememberedCloud = loadCloudChoice();
        await restart(await browserStorage());
        notify(
          loaded[3].label +
            " could not be opened, so HAXcms started from this browser's storage. " +
            String((error && error.message) || error),
        );
        return;
      }
      if (loaded[3].kind !== "folder") {
        throw error;
      }
      // the remembered folder is gone or unreadable: carry on without it
      console.warn("[haxcms-browser]", error);
      await forgetFolder();
      remembered = null;
      await restart(await browserStorage());
      notify(
        "The folder used last time could not be opened, so HAXcms started from this browser's storage.",
      );
    }
  }

  // A folder can be changed by other programs while this tab is in the
  // background; pick that up when the user comes back.
  let refreshing = false;
  function refreshFromFolder() {
    if (
      !running ||
      refreshing ||
      storage.kind !== "folder" ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    refreshing = true;
    send("refreshStorage", {})
      .then((result) => {
        if (result.updated || result.removed) {
          notify(
            "Picked up changes made in the folder outside HAXcms (" +
              (result.updated + result.removed) +
              " file(s)). Reload the page you are on to see them.",
          );
        }
      })
      .catch((error) => console.warn("[haxcms-browser]", error))
      .finally(() => {
        refreshing = false;
      });
  }
  document.addEventListener("visibilitychange", refreshFromFolder);
  globalThis.addEventListener("focus", refreshFromFolder);

  // with nowhere to save, closing or reloading loses the sites: say so first
  globalThis.addEventListener("beforeunload", (event) => {
    if (running && storage.kind === "memory") {
      event.preventDefault();
    }
  });

  start().catch((error) => fail("HAXcms could not start", error));
})();
