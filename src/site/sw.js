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
 *       -> not touched
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
 * - Nothing is cached here and nothing leaves the browser: relayed requests
 *   never reach the network.
 */
const SCOPE = new URL(self.registration.scope).pathname;
const APP = SCOPE + "app/";
const STATIC = SCOPE + "public/";
const HOST_PATHS = [SCOPE, SCOPE + "index.html"];
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
  event.waitUntil(self.clients.claim());
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

// Fetch a file from the static front-end folder and hand it back as if it
// came from the requested address. The copy matters: a response that kept
// its real URL (<scope>public/...) would make the browser resolve the
// module's own imports there, and load modules twice under two addresses.
async function staticFile(path) {
  const response = await fetch(STATIC + path);
  return new Response(response.body, {
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
    '<link rel="stylesheet" href="' +
    SCOPE +
    'shell.css"></head><body>' +
    '<header class="bar" role="banner"><p class="bar-status">' +
    '<span class="dot" data-state="ready" aria-hidden="true"></span>' +
    "<span>HAXcms is running in your browser</span></p>" +
    '<p class="bar-note">This page comes from the tab where you started HAXcms. ' +
    "Keep that tab open: reloading or closing it ends the session and its sites.</p>" +
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
      if (!mount && url.pathname.indexOf(SCOPE) !== 0) {
        // an absolute link from a HAXcms page ("/system/api/...")
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
        pageOrigin: self.location.origin,
      },
    },
    body ? [body] : [],
  );
  if (!result) {
    return page(
      503,
      "This HAXcms session is not open",
      "HAXcms runs inside the page that started it, and that page is closed or was reloaded. Sites made in the browser demo are kept in memory, so they are gone when it closes.",
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
  // the host page's own files never need the relay
  const inScope = url.pathname.indexOf(SCOPE) === 0;
  if (inScope && url.pathname.indexOf(APP) !== 0) {
    return;
  }
  event.respondWith(
    handle(event, url).catch((e) =>
      page(500, "HAXcms could not answer", String((e && e.message) || e)),
    ),
  );
});
