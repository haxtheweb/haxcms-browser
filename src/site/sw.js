/**
 * Service worker for the haxcms-browser host page (haxtheweb/issues#3331).
 *
 * The host page (index.html) runs haxcms-nodejs in a Worker and shows HAXcms
 * in an iframe mounted at <scope>app/<session>/. This service worker is what
 * makes those iframe pages work: it answers their requests.
 *
 *   front-end build files (build/, wc-registry.json, ...)
 *       -> fetched as static files from <scope>public/, where the site build
 *          put haxcms-nodejs's own front end
 *   everything else under the mount (pages, API calls, site files)
 *       -> relayed to the host page, which passes it to its Worker; the
 *          Worker's answer comes back as the response
 *   a HAXcms page opened in its own tab
 *       -> wrapped in the host page's status bar, with the page in a frame
 *   the host page's own files (index.html, the Worker bundle, ...)
 *       -> fetched from the web server as they are, unless this browser has
 *          an offline copy (below)
 *   something shared to the installed app from another app (POST <scope>share)
 *       -> held in this browser until the host page asks what to do with it
 *   reset.html
 *       -> never handled here, so it always comes from the web server
 *
 * A service worker cannot talk to a page's Worker directly, and each open
 * host page has its own Worker (its own in-memory sites). So a request is
 * offered to every open host page with its session id, and only the page
 * that owns that session answers.
 *
 * Rules this file keeps:
 * - Only requests for this origin are handled, and only for a session mount
 *   or from a page inside one.
 * - Navigations are relayed for GET only. A write (POST, PUT, PATCH, DELETE)
 *   is relayed only when it comes from a page inside the session's mount,
 *   so another site cannot submit a form into a running session.
 * - Nothing leaves the browser: relayed requests never reach the network, and
 *   their answers are never stored.
 *
 * The offline copy (src/site/offline.js saves it; this file only reads it).
 * - There is no copy until the person installs the app or asks for offline
 *   use. Without one, every static file comes from the web server, exactly as
 *   if this file did no caching at all.
 * - A copy is one whole build of the site, saved by the host page. Nothing
 *   is added to it file by file as pages load, so it can never be a mix of
 *   two builds.
 * - With a copy, the host page and the front end are served from it, so the
 *   app starts with no connection and its parts always match each other.
 *   The host page then checks the web server for a newer build and offers to
 *   update. A file the copy does not have comes from the web server.
 * - Getting out is always possible: reset.html is never handled here, a
 *   failure while reading the copy falls back to the web server, and a
 *   change of OFFLINE_FORMAT makes every browser drop its copy.
 */
const SCOPE = new URL(self.registration.scope).pathname;
const APP = SCOPE + "app/";
const STATIC = SCOPE + "public/";
const HOST_PATHS = [SCOPE, SCOPE + "index.html"];
// what the host page itself is made of; never relayed, even when a HAXcms
// page asks for one (the wrapper around a page in its own tab uses two)
const HOST_FILES = [
  "",
  "index.html",
  "shell.js",
  "shell.css",
  "frame.js",
  "offline.js",
  "share.js",
  "publish.js",
  "publish-hosts.js",
  "auth.js",
  "accounts.js",
  "oauth/callback.html",
  "oauth/callback.js",
  "sw.js",
  "haxcms-worker.js",
  "haxcms-snapshot.json",
  "version.json",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];
// always from the web server, whatever this file is doing: the way out
// (reset.html), and the lists an offline copy is checked against
const RESET_PAGE = SCOPE + "reset.html";
const ALWAYS_NETWORK = [SCOPE + "offline-manifest.json"];
const ALWAYS_NETWORK_FOLDER = SCOPE + "offline-locales/";
// where another app's share lands when HAX is installed (manifest.webmanifest)
const SHARE_TARGET = SCOPE + "share";

function isHostFile(pathname) {
  if (pathname.indexOf(SCOPE) !== 0) {
    return false;
  }
  const rest = pathname.slice(SCOPE.length);
  return HOST_FILES.indexOf(rest) !== -1 || rest.indexOf("public/") === 0;
}

// --- the offline copy ----------------------------------------------------
// Names and layout are shared with offline.js and reset.html. The scope is
// part of the name because other sites on this origin (GitHub Pages) share
// the same cache storage.
const OFFLINE_FORMAT = 1;
const OFFLINE_ALL = "haxcms-browser-offline:";
const OFFLINE_PREFIX = OFFLINE_ALL + OFFLINE_FORMAT + ":" + SCOPE + ":";
// written last when a copy is saved: a cache without it is not a copy
const OFFLINE_META = self.location.origin + SCOPE + "__offline/meta.json";

// which cache holds the copy, or null; looked up once and kept until the
// host page says the copy changed
let offlineLookup = null;

async function findOfflineCopy() {
  const names = await caches.keys();
  let best = null;
  for (const name of names) {
    if (name.indexOf(OFFLINE_PREFIX) !== 0) {
      continue;
    }
    const cache = await caches.open(name);
    const saved = await cache.match(OFFLINE_META);
    const meta = saved ? await saved.json().catch(() => null) : null;
    if (meta && (!best || String(meta.savedAt) > String(best.meta.savedAt))) {
      best = { cache, meta };
    }
  }
  return best;
}

function offlineCopy() {
  if (!offlineLookup) {
    offlineLookup = findOfflineCopy().catch(() => null);
  }
  return offlineLookup;
}

// A static file by its address on the web server: from the offline copy
// when there is one and it has the file, otherwise from the web server.
// Anything that goes wrong on the way to the copy ends at the web server.
// A request marked no-store is the host page asking for the web server's
// own file (that is how it saves and updates the copy), so it skips the copy.
async function staticFetch(address, request) {
  if (request && request.cache === "no-store") {
    return fetch(request);
  }
  let saved = null;
  try {
    const copy = await offlineCopy();
    if (copy) {
      saved = await copy.cache.match(address);
    }
  } catch (e) {
    saved = null;
  }
  return saved || fetch(request || address);
}

// the host page is one file whatever follows the "?" (./?share=...)
function hostFileAddress(pathname) {
  const rest = pathname.slice(SCOPE.length);
  return self.location.origin + SCOPE + (rest === "" ? "index.html" : rest);
}

// --- things shared to the installed app -----------------------------------
// Another app's share arrives as a form post. It is put in this browser's
// storage and the host page is opened, which shows what arrived and asks
// which site it is for. Nothing is added to a site here. Limits keep a
// page that posts to this address on its own from filling the browser up.
const SHARE_CACHE = "haxcms-browser-share:" + SCOPE;
const SHARE_BASE = self.location.origin + SCOPE + "__share/";
const SHARE_MAX_FILES = 10;
const SHARE_MAX_BYTES = 200 * 1024 * 1024;
const SHARE_MAX_TEXT = 20000;
const SHARE_KEEP = 5;

function shareText(form, name) {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, SHARE_MAX_TEXT) : "";
}

async function receiveShare(request) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const files = [];
    let bytes = 0;
    for (const file of form.getAll("files")) {
      if (typeof file === "string" || files.length >= SHARE_MAX_FILES) {
        continue;
      }
      bytes += file.size;
      if (bytes > SHARE_MAX_BYTES) {
        break;
      }
      const key = SHARE_BASE + id + "/file/" + files.length;
      await cache.put(
        key,
        new Response(file, {
          headers: {
            "content-type": file.type || "application/octet-stream",
          },
        }),
      );
      files.push({
        name: String(file.name || "file").slice(0, 200),
        type: file.type || "",
        size: file.size,
        key,
      });
    }
    const item = {
      id,
      when: Date.now(),
      title: shareText(form, "title"),
      text: shareText(form, "text"),
      url: shareText(form, "url"),
      files,
    };
    if (item.title || item.text || item.url || files.length) {
      await cache.put(
        SHARE_BASE + id + "/item.json",
        new Response(JSON.stringify(item), {
          headers: { "content-type": "application/json" },
        }),
      );
      await pruneShares(cache);
    }
  } catch (e) {
    // not a share this can read: just open the app
  }
  return Response.redirect(SCOPE + "?share=" + id, 303);
}

// keep the newest few shares; drop the rest with their files
async function pruneShares(cache) {
  const items = [];
  for (const request of await cache.keys()) {
    if (/\/item\.json$/.test(request.url)) {
      const saved = await cache.match(request);
      const item = saved ? await saved.json().catch(() => null) : null;
      if (item) {
        items.push(item);
      }
    }
  }
  items.sort((a, b) => b.when - a.when);
  for (const item of items.slice(SHARE_KEEP)) {
    for (const file of item.files || []) {
      await cache.delete(file.key);
    }
    await cache.delete(SHARE_BASE + item.id + "/item.json");
  }
}
// a host page that owns the session answers "got it" at once; the real
// response can take as long as the work does (creating a site, an import)
const ACK_TIMEOUT_MS = 4000;
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const NULL_BODY_STATUS = [101, 204, 205, 304];
// set by the browser or meaningless once the body has been re-wrapped here
const DROP_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
];

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // offline copies saved in a layout this file no longer reads
      for (const name of await caches.keys()) {
        if (
          name.indexOf(OFFLINE_ALL) === 0 &&
          name.indexOf(":" + SCOPE + ":") !== -1 &&
          name.indexOf(OFFLINE_PREFIX) !== 0
        ) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});
// the host page saved, updated or removed the offline copy
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "haxcms-offline-changed") {
    offlineLookup = null;
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ ok: true });
    }
  }
});

// "/haxcms-browser/app/k3j2/_sites/x/" -> { session: "k3j2", path: "/_sites/x/" }
function parseMount(pathname) {
  if (pathname.indexOf(APP) !== 0) {
    return null;
  }
  const rest = pathname.slice(APP.length);
  const slash = rest.indexOf("/");
  const session = slash === -1 ? rest : rest.slice(0, slash);
  if (!/^[a-z0-9]{6,32}$/.test(session)) {
    return null;
  }
  return { session, path: slash === -1 ? "/" : rest.slice(slash) };
}

// Same test haxcms-nodejs uses to send a request to its front-end build
// (app.js isBuildAssetRequest / getBuildAssetRequestPath).
function buildAssetPath(path) {
  if (path.indexOf("/custom/build/") !== -1) {
    return null;
  }
  const build = path.indexOf("/build/");
  if (build !== -1) {
    return path.slice(build + 1);
  }
  for (const file of ["wc-registry.json", "build-haxcms.js", "build.js"]) {
    if (path.slice(-(file.length + 1)) === "/" + file) {
      return file;
    }
  }
  return null;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(status, pageTitle, pageMessage) {
  const title = escapeHtml(pageTitle);
  const message = escapeHtml(pageMessage);
  const html =
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" +
    title +
    "</title>" +
    '<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5">' +
    "<h1>" +
    title +
    "</h1><p>" +
    message +
    '</p><p><a href="' +
    SCOPE +
    '" target="_top">Open HAXcms in the browser</a></p></body></html>';
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// The code editor (monaco) runs inside a blank frame it creates, and Chrome
// does not route a blank frame's requests through a service worker. So it is
// told where its files really are on the web server, not under the mount:
// the one place its script works out its own address is swapped for that.
// If the script ever changes shape this does nothing, and the test for the
// code editor fails.
const CODE_EDITOR = "@haxtheweb/code-editor/code-editor.js";
const CODE_EDITOR_OWN_ADDRESS =
  'new URL("./code-editor.js",import.meta.url).href';

// Fetch a file from the static front-end folder and hand it back as if it
// came from the requested address. The copy matters: a response that kept
// its real URL (<scope>public/...) would make the browser resolve the
// module's own imports there, and load modules twice under two addresses.
async function staticFile(path) {
  const response = await staticFetch(self.location.origin + STATIC + path);
  let body = response.body;
  if (response.ok && path.slice(-CODE_EDITOR.length) === CODE_EDITOR) {
    body = (await response.text())
      .split(CODE_EDITOR_OWN_ADDRESS)
      .join(JSON.stringify(self.location.origin + STATIC + path));
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// A HAXcms page opened in its own tab (the dashboard's "Go to Site") gets the
// same status bar as the host page: this wrapper shows the bar and loads the
// real page in a frame. The frame's request comes back here as an iframe
// navigation and is relayed as usual.
function framePage(url) {
  const target = escapeHtml(url.pathname + url.search + url.hash);
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>HAXcms in your browser</title>" +
    '<link rel="icon" href="' +
    SCOPE +
    'public/assets/favicon.ico">' +
    '<link rel="stylesheet" href="' +
    SCOPE +
    'shell.css"></head><body>' +
    '<header class="bar" role="banner"><p class="bar-status">' +
    '<span class="dot" data-state="ready" aria-hidden="true"></span>' +
    "<span>HAXcms is running in your browser</span></p>" +
    '<p class="bar-note">This page comes from the tab where you started HAXcms. ' +
    "Keep that tab open while you work here.</p>" +
    '<nav class="bar-links" aria-label="About this demo">' +
    '<a href="https://haxtheweb.org/" target="_blank" rel="noopener">Install HAX</a>' +
    "</nav></header>" +
    '<main class="stage"><iframe id="app" title="HAXcms" src="' +
    target +
    '"></iframe></main><script src="' +
    SCOPE +
    'frame.js"></script></body></html>';
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Offer the request to every open host page; the one that owns the session
// acknowledges and then answers.
async function relay(session, message, transfer) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const hosts = windows.filter(
    (client) => HOST_PATHS.indexOf(new URL(client.url).pathname) !== -1,
  );
  if (hosts.length === 0) {
    return null;
  }
  return new Promise((resolve) => {
    let acknowledged = false;
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    setTimeout(() => {
      if (!acknowledged) {
        finish(null);
      }
    }, ACK_TIMEOUT_MS);
    setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);
    hosts.forEach((client, index) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const data = event.data || {};
        if (data.ack) {
          acknowledged = true;
        } else if (data.response) {
          finish(data.response);
        } else if (data.error) {
          finish({ error: data.error });
        }
      };
      // the body can only be transferred once; later pages get a copy
      client.postMessage(
        Object.assign({ type: "haxcms-request", session }, message),
        index === hosts.length - 1
          ? [channel.port2].concat(transfer)
          : [channel.port2],
      );
    });
  });
}

function toResponse(result, mountPrefix) {
  const headers = new Headers();
  for (const name of Object.keys(result.headers || {})) {
    if (DROP_RESPONSE_HEADERS.indexOf(name) !== -1) {
      continue;
    }
    const value = result.headers[name];
    for (const one of Array.isArray(value) ? value : [value]) {
      let text = String(one);
      if (name === "location") {
        // HAXcms answers with links from its own root; put them back under
        // this session's mount
        if (text.indexOf("http://localhost/") === 0) {
          text = text.slice("http://localhost".length);
        }
        if (text.charAt(0) === "/" && text.charAt(1) !== "/") {
          text = mountPrefix + text;
        }
      }
      try {
        headers.append(name, text);
      } catch (e) {
        // a header the browser does not allow on a response
      }
    }
  }
  const noBody = NULL_BODY_STATUS.indexOf(result.status) !== -1;
  return new Response(noBody ? null : result.body, {
    status: result.status,
    statusText: result.statusText || "",
    headers,
  });
}

async function handle(event, url) {
  const request = event.request;
  const navigation = request.mode === "navigate";
  let mount = parseMount(url.pathname);
  let fromSessionPage = false;
  // which session is the requesting page in?
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    const clientMount = client
      ? parseMount(new URL(client.url).pathname)
      : null;
    if (clientMount) {
      fromSessionPage = true;
      if (!mount) {
        // a link from a HAXcms page that starts at the web root
        // ("/system/api/..."), wherever this site itself is served from
        mount = { session: clientMount.session, path: url.pathname };
      } else if (mount && mount.session !== clientMount.session) {
        return page(
          403,
          "Not this session",
          "That link belongs to a different HAXcms tab.",
        );
      }
    }
  }
  if (!mount) {
    // the host page's own files, or a request that is not ours
    return fetch(request);
  }
  const method = request.method.toUpperCase();
  const readOnly = method === "GET" || method === "HEAD";
  if (!readOnly && (navigation || !fromSessionPage)) {
    return page(
      405,
      "Not allowed",
      "Changes can only be made from inside HAXcms.",
    );
  }
  const asset = readOnly ? buildAssetPath(mount.path) : null;
  if (asset) {
    return staticFile(asset);
  }
  if (navigation && request.destination === "document") {
    return framePage(url);
  }
  const mountPrefix = APP + mount.session;
  const headers = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (request.referrer) {
    headers.referer = request.referrer;
  }
  if (!readOnly) {
    // a write from a page inside the mount is a same-origin request
    headers.origin = self.location.origin;
  }
  let body = null;
  if (!readOnly) {
    const bytes = await request.arrayBuffer();
    body = bytes.byteLength ? bytes : null;
  }
  const result = await relay(
    mount.session,
    {
      request: {
        method,
        url: mount.path + url.search,
        headers,
        body,
      },
    },
    body ? [body] : [],
  );
  if (!result) {
    return page(
      503,
      "This HAXcms session is not open",
      "HAXcms runs inside the page that started it, and that page is closed or was reloaded. Open HAXcms again to carry on; this address belonged to the earlier session.",
    );
  }
  if (result.error) {
    return page(
      500,
      "HAXcms could not answer",
      "The in-browser runtime reported an error. The browser console has the details.",
    );
  }
  if (result.status === 404 && readOnly) {
    // a file from haxcms-nodejs's public folder that is not in the volume
    const fallback = await staticFile(mount.path.replace(/^\/+/, "")).catch(
      () => null,
    );
    if (fallback && fallback.ok) {
      return fallback;
    }
  }
  return toResponse(result, mountPrefix);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (
    url.pathname === RESET_PAGE ||
    ALWAYS_NETWORK.indexOf(url.pathname) !== -1 ||
    url.pathname.indexOf(ALWAYS_NETWORK_FOLDER) === 0
  ) {
    return;
  }
  if (url.pathname === SHARE_TARGET && event.request.method === "POST") {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (isHostFile(url.pathname)) {
    if (event.request.method !== "GET" || url.pathname === SCOPE + "sw.js") {
      return;
    }
    event.respondWith(
      staticFetch(hostFileAddress(url.pathname), event.request),
    );
    return;
  }
  event.respondWith(
    handle(event, url).catch((e) =>
      page(500, "HAXcms could not answer", String((e && e.message) || e)),
    ),
  );
});
