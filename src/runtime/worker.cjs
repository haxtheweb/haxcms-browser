/**
 * haxcms-nodejs in a browser Worker (haxtheweb/issues#3331).
 *
 * The page talks to the Worker with messages: { id, type, ...args } in,
 * { id, ok, result } or { id, ok: false, error } out. Messages are handled
 * one at a time, in order.
 *
 *   boot        { snapshot, root, basePath, origin, storage }
 *                                   load the data snapshot into the volume and
 *                                   start haxcms-nodejs (the full Express app,
 *                                   embedded) with root as its HAXcms root.
 *                                   basePath is where the page mounts HAXcms
 *                                   (e.g. "/haxcms-browser/app/"), used for
 *                                   the links HAXcms generates. storage is
 *                                   { handle }: a FileSystemDirectoryHandle
 *                                   the sites folder is loaded from and
 *                                   saved to (see storage.cjs), or
 *                                   { remote: { provider, webdav } }: cloud
 *                                   storage (remote.cjs), signed in with
 *                                   tokens the page sends on request (see
 *                                   "token-request" below); without either
 *                                   sites only live in memory
 *   request     { method, url, headers, body, binary }
 *                                   send one HTTP request through the app;
 *                                   resolves { status, statusText, headers,
 *                                   body }. Bodies are base64 strings, or
 *                                   ArrayBuffers (in: when given one, out:
 *                                   when binary is true)
 *   useStorage  { handle | remote } start saving the sites folder to this
 *                                   (empty) folder or cloud storage;
 *                                   everything in memory is written to it
 *   refreshStorage {}               pick up files changed in the folder by
 *                                   another program
 *   signIn      {}                  sign in as the local user through the real
 *                                   login route, with the credentials
 *                                   haxcms-nodejs seeded on first boot;
 *                                   resolves the login response (the host
 *                                   keeps its Set-Cookie for the session)
 *   readFile    { path }            read a file from the volume (base64)
 *   hashPassword { password }       HAXCMS.hashPassword (portability check)
 *   listSites   {}                  the sites that can be published:
 *                                   [{ name, title, domain }] (publish.cjs)
 *   inspectRemote { remote }        how many entries cloud storage's HAXcms
 *                                   folder holds: { entries }
 *   siteFiles   { name }            the same files packSite packs, one by
 *                                   one, for hosts that take files:
 *                                   { files: [{ path, body }] } (bodies
 *                                   are ArrayBuffers, transferred)
 *   packSite    { name }            one site packed for a static host, the
 *                                   same files the HAX CLI publishes:
 *                                   resolves { files, bytes, body } with
 *                                   body a gzipped tarball (ArrayBuffer),
 *                                   llms-full.txt included as HAXcms
 *                                   serves it. Reads only; the site is
 *                                   not changed
 *
 * Everything runs through the real haxcms-nodejs code. app.js is loaded with
 * HAXCMS_EMBEDDED=1 (no HTTP server, no listening, no timers; requests are
 * dispatched to the Express app here) and in local mode
 * (HAXCMS_DISABLE_JWT_CHECKS, the same single-user mode as `hax serve`): the
 * Worker only receives messages from the page that created it, on the user's
 * own machine, so there is no remote caller to authenticate.
 *
 * Saving. With storage, every request that can change something (anything
 * but GET, HEAD, OPTIONS) is followed by writing the changed files to the
 * handle before its response is returned. If that write fails, the response
 * becomes a 500 in HAXcms's error shape with the code
 * BROWSER_STORAGE_WRITE_FAILED: a save never reports success unless it
 * reached the folder. The unsaved files are retried on the next write.
 *
 * Requests carry the address of the page HAXcms is shown on (boot's
 * `origin`, e.g. https://haxtheweb.github.io): the Host header, and whether
 * the connection counts as https, come from it, and Origin / Referer are
 * passed through as the browser sent them. haxcms-nodejs builds some
 * absolute URLs from the request's host (the file upload endpoint, for one),
 * so they have to be addresses the page can actually reach. Without an
 * origin (tests that talk to the Worker directly) it is http://localhost.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { DirectoryStorage } = require("./storage.cjs");
const publish = require("./publish.cjs");
const { createRemoteRoot } = require("./remote.cjs");

const DEFAULT_ORIGIN = "http://localhost";

const state = {
  HAXCMS: null,
  app: null,
  storage: null,
  origin: new URL(DEFAULT_ORIGIN),
};

const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"];

function sitesFolder() {
  const HAXCMS = requireBooted();
  return path.join(HAXCMS.HAXCMS_ROOT, HAXCMS.sitesDirectory);
}

function storageFor(handle) {
  return new DirectoryStorage({ fs, path, handle, root: sitesFolder() });
}

// Cloud storage signs in with the page's tokens. The Worker asks the page
// for a current one (and for a renewed one when the service says it has run
// out); the answer comes back as a "token-reply" message, outside the
// one-message-at-a-time queue, so a save waiting for a token can't block it.
let nextTokenRequest = 0;
// request id -> the function that settles it (an object with no prototype,
// so only ids set here are found)
const tokenWaiters = Object.create(null);
function requestToken(provider, force) {
  return new Promise((resolve) => {
    const requestId = ++nextTokenRequest;
    const timer = setTimeout(() => {
      delete tokenWaiters[requestId];
      resolve(null);
    }, 60 * 1000);
    tokenWaiters[requestId] = (token) => {
      clearTimeout(timer);
      resolve(typeof token === "string" && token ? token : null);
    };
    globalThis.postMessage({
      type: "token-request",
      requestId,
      provider,
      force: !!force,
    });
  });
}

// the directory handle for a storage choice: a handle the page passed (a
// folder or the browser's own storage), or cloud storage built here
async function handleFor(choice) {
  if (choice && choice.handle) {
    return choice.handle;
  }
  if (choice && choice.remote) {
    const remote = choice.remote;
    return createRemoteRoot({
      provider: remote.provider,
      webdav: remote.webdav,
      getToken: (force) => requestToken(remote.provider, force),
    });
  }
  return null;
}

function requireBooted() {
  if (!state.HAXCMS) {
    throw new Error("boot must be called first");
  }
  return state.HAXCMS;
}

// llms-full.txt as haxcms-nodejs answers it, so a static host has it too;
// anything but a 200 (a private site answers 404) adds nothing
async function llmsFullExtra(HAXCMS, name) {
  const extras = [];
  const llms = await handlers.request({
    method: "GET",
    url: "/" + HAXCMS.sitesDirectory + "/" + name + "/llms-full.txt",
    headers: { accept: "text/markdown" },
    binary: true,
  });
  if (llms && llms.status === 200 && llms.body) {
    extras.push({ path: "llms-full.txt", bytes: new Uint8Array(llms.body) });
  }
  return extras;
}

const handlers = {
  async boot({ snapshot, root, basePath, origin, storage }) {
    if (state.HAXCMS) {
      throw new Error("already booted");
    }
    if (origin) {
      state.origin = new URL(origin);
    }
    const start = performance.now();
    const volume = fs.__volume;
    for (const [file, base64] of Object.entries(snapshot || {})) {
      volume.mkdirSync(path.dirname(file), { recursive: true });
      volume.writeFileSync(file, Buffer.from(base64, "base64"));
    }
    const haxcmsRoot = root || "/haxcms";
    // homedir (/home) is where haxcms-nodejs creates its default config
    for (const dir of [haxcmsRoot, "/home", "/tmp"]) {
      volume.mkdirSync(dir, { recursive: true });
    }
    process.env.HAXCMS_ROOT = haxcmsRoot + "/";
    process.env.HAXCMS_EMBEDDED = "1";
    process.env.HAXCMS_DISABLE_JWT_CHECKS = "true";
    process.chdir(haxcmsRoot);
    const appModule = require("haxcms-nodejs/app.js");
    if (!appModule.embeddedRuntime) {
      throw new Error(
        "this haxcms-nodejs does not support HAXCMS_EMBEDDED; build against a version that does",
      );
    }
    await appModule.appReady;
    const { HAXCMS } = require("haxcms-nodejs/lib/HAXCMS.js");
    if (basePath) {
      HAXCMS.basePath = String(basePath);
    }
    state.app = appModule.app;
    state.HAXCMS = HAXCMS;
    let loaded = null;
    const handle = await handleFor(storage);
    if (handle) {
      state.storage = storageFor(handle);
      loaded = await state.storage.load();
    }
    return {
      loaded,
      mode: HAXCMS.runtimeServerMode || "multisite",
      bootMs: Math.round(performance.now() - start),
      unavailable: Array.from(globalThis.__haxcmsUnavailable || []).sort(),
    };
  },
  async request({ method, url, headers, body, binary }) {
    requireBooted();
    const target = String(url || "/");
    if (target.charAt(0) !== "/") {
      throw new Error("request url must be a path, e.g. /system/api/v1/sites");
    }
    const out = {};
    const incoming = headers || {};
    for (const name of Object.keys(incoming)) {
      out[name.toLowerCase()] = String(incoming[name]);
    }
    out.host = state.origin.host;
    let payload = null;
    if (typeof body === "string") {
      payload = Buffer.from(body, "base64");
    } else if (body) {
      payload = Buffer.from(body);
    }
    if (payload && out["content-length"] === undefined) {
      out["content-length"] = String(payload.length);
    }
    const response = await http.dispatch(state.app, {
      method,
      url: target,
      headers: out,
      body: payload,
      encrypted: state.origin.protocol === "https:",
    });
    let bytes = response.body;
    let saveFailed = null;
    const verb = String(method || "GET").toUpperCase();
    if (state.storage && READ_ONLY_METHODS.indexOf(verb) === -1) {
      try {
        await state.storage.flush();
      } catch (e) {
        // the change exists in memory but not in the folder: do not let the
        // caller believe it was saved
        saveFailed = String((e && e.message) || e);
        console.error("[haxcms-browser] " + saveFailed);
        response.status = 500;
        response.statusText = "Internal Server Error";
        response.headers = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        };
        bytes = Buffer.from(
          JSON.stringify({
            status: 500,
            data: {
              message:
                "Your changes could not be saved to storage. " + saveFailed,
              code: "BROWSER_STORAGE_WRITE_FAILED",
            },
          }),
        );
      }
    }
    return {
      saveFailed,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: binary
        ? bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          )
        : bytes.toString("base64"),
    };
  },
  async useStorage(choice) {
    requireBooted();
    const handle = await handleFor(choice);
    if (!handle) {
      throw new Error("no storage to use");
    }
    const storage = storageFor(handle);
    // nothing is known to be on the new handle, so this writes everything
    const result = await storage.flush();
    state.storage = storage;
    return result;
  },
  async refreshStorage() {
    requireBooted();
    if (!state.storage) {
      return { updated: 0, removed: 0 };
    }
    return state.storage.refresh();
  },
  async signIn() {
    const HAXCMS = requireBooted();
    const passwordFile = path.join(
      HAXCMS.configDirectory,
      ".initial-admin-password",
    );
    if (!fs.existsSync(passwordFile)) {
      throw new Error("no seeded local user to sign in as");
    }
    // "username: <name>" and "password: <value>" lines, then a comment
    const seeded = {};
    for (const line of fs.readFileSync(passwordFile, "utf8").split("\n")) {
      const colon = line.indexOf(":");
      if (colon > 0 && line.charAt(0) !== "#") {
        seeded[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
    }
    const credentials = {
      username: seeded.username || HAXCMS.getActiveUserName(),
      password: seeded.password || "",
    };
    return handlers.request({
      method: "POST",
      url: "/system/api/v1/session/login",
      headers: {
        "content-type": "application/json",
        origin: state.origin.origin,
      },
      body: Buffer.from(JSON.stringify(credentials)).toString("base64"),
    });
  },
  readFile({ path: file }) {
    requireBooted();
    return fs.readFileSync(file).toString("base64");
  },
  hashPassword({ password }) {
    return requireBooted().hashPassword(password);
  },
  listSites() {
    requireBooted();
    return publish.listSites(fs, path, sitesFolder());
  },
  async inspectRemote({ remote }) {
    requireBooted();
    const handle = await handleFor({ remote });
    let entries = 0;
    for await (const entry of handle.entries()) {
      if (entry) {
        entries++;
      }
    }
    return { entries };
  },
  async siteFiles({ name }) {
    const HAXCMS = requireBooted();
    if (!publish.validSiteName(name)) {
      throw new Error("not a site name: " + String(name));
    }
    const siteDir = path.join(sitesFolder(), name);
    if (!fs.existsSync(siteDir) || !fs.lstatSync(siteDir).isDirectory()) {
      throw new Error("no site named " + name);
    }
    const extras = await llmsFullExtra(HAXCMS, name);
    const files = publish.publishFiles(fs, path, siteDir, extras);
    return {
      files: files.map((file) => {
        const bytes =
          file.bytes instanceof Uint8Array
            ? file.bytes
            : new Uint8Array(file.bytes);
        return {
          path: file.path,
          body: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        };
      }),
    };
  },
  async packSite({ name }) {
    const HAXCMS = requireBooted();
    if (!publish.validSiteName(name)) {
      throw new Error("not a site name: " + String(name));
    }
    const siteDir = path.join(sitesFolder(), name);
    if (!fs.existsSync(siteDir) || !fs.lstatSync(siteDir).isDirectory()) {
      throw new Error("no site named " + name);
    }
    const extras = await llmsFullExtra(HAXCMS, name);
    return publish.packSite(fs, path, siteDir, extras);
  },
};

// message type -> handler; only these names can be called
// Each message type is named here: nothing a message says picks a function.
function handle(message) {
  switch (message.type) {
    case "boot":
      return handlers.boot(message);
    case "request":
      return handlers.request(message);
    case "useStorage":
      return handlers.useStorage(message);
    case "refreshStorage":
      return handlers.refreshStorage(message);
    case "signIn":
      return handlers.signIn(message);
    case "readFile":
      return handlers.readFile(message);
    case "hashPassword":
      return handlers.hashPassword(message);
    case "listSites":
      return handlers.listSites(message);
    case "packSite":
      return handlers.packSite(message);
    case "siteFiles":
      return handlers.siteFiles(message);
    case "inspectRemote":
      return handlers.inspectRemote(message);
    default:
      throw new Error("unknown message type " + String(message.type));
  }
}

// One message at a time. A message that never settles would hold up every
// later one, so two things end it early: an error nothing caught while it
// was running (in Node that would have ended the process), and a time limit.
const MESSAGE_TIMEOUT_MS = 10 * 60 * 1000;
let failCurrent = null;

globalThis.addEventListener("error", (event) => {
  if (failCurrent) {
    failCurrent(event.error || new Error(event.message));
    event.preventDefault();
  }
});
globalThis.addEventListener("unhandledrejection", (event) => {
  if (failCurrent) {
    failCurrent(event.reason);
    event.preventDefault();
  }
});

function run(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(message.type + " took too long and was stopped")),
      MESSAGE_TIMEOUT_MS,
    );
    failCurrent = reject;
    Promise.resolve()
      .then(() => handle(message))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  }).finally(() => {
    failCurrent = null;
  });
}

let queue = Promise.resolve();
globalThis.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "token-reply") {
    // answered at once, outside the queue (see requestToken); only an id
    // this Worker handed out finds a waiting request
    const requestId = Number(message.requestId);
    if (
      Number.isInteger(requestId) &&
      Object.prototype.hasOwnProperty.call(tokenWaiters, requestId)
    ) {
      const waiting = tokenWaiters[requestId];
      delete tokenWaiters[requestId];
      if (typeof waiting === "function") {
        waiting(message.token);
      }
    }
    return;
  }
  queue = queue.then(async () => {
    try {
      const result = await run(message);
      const transfer =
        result && result.body instanceof ArrayBuffer ? [result.body] : [];
      if (result && Array.isArray(result.files)) {
        for (const file of result.files) {
          if (file && file.body instanceof ArrayBuffer) {
            transfer.push(file.body);
          }
        }
      }
      globalThis.postMessage({ id: message.id, ok: true, result }, transfer);
    } catch (e) {
      console.error("[haxcms-browser] " + String((e && e.stack) || e));
      globalThis.postMessage({
        id: message.id,
        ok: false,
        error: String((e && e.stack) || e),
      });
    }
  });
};
