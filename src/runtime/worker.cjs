/**
 * haxcms-nodejs in a browser Worker (haxtheweb/issues#3331).
 *
 * The page talks to the Worker with messages: { id, type, ...args } in,
 * { id, ok, result } or { id, ok: false, error } out. Messages are handled
 * one at a time, in order.
 *
 *   boot        { snapshot, root }  load the data snapshot into the volume and
 *                                   start haxcms-nodejs (the full Express app,
 *                                   embedded) with root as its HAXcms root
 *   request     { method, url, headers, body, pageOrigin }
 *                                   send one HTTP request through the app;
 *                                   resolves { status, statusText, headers,
 *                                   body } (bodies are base64)
 *   readFile    { path }            read a file from the volume (base64)
 *   hashPassword { password }       HAXCMS.hashPassword (portability check)
 *
 * Everything runs through the real haxcms-nodejs code. app.js is loaded with
 * HAXCMS_EMBEDDED=1 (no HTTP server, no listening, no timers; requests are
 * dispatched to the Express app here) and in local mode
 * (HAXCMS_DISABLE_JWT_CHECKS, the same single-user mode as `hax serve`): the
 * Worker only receives messages from the page that created it, on the user's
 * own machine, so there is no remote caller to authenticate.
 *
 * Requests are addressed to the internal origin http://localhost: the Host
 * header is always "localhost", and Origin / Referer are rewritten from the
 * page's origin to it, so haxcms-nodejs's same-origin checks see a local
 * request. Anything from another origin keeps its value and is refused by
 * those checks as usual.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const INTERNAL_ORIGIN = "http://localhost";

const state = { HAXCMS: null, app: null };

function requireBooted() {
  if (!state.HAXCMS) {
    throw new Error("boot must be called first");
  }
  return state.HAXCMS;
}

const handlers = {
  async boot({ snapshot, root }) {
    if (state.HAXCMS) {
      throw new Error("already booted");
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
    state.app = appModule.app;
    state.HAXCMS = HAXCMS;
    return {
      mode: HAXCMS.runtimeServerMode || "multisite",
      bootMs: Math.round(performance.now() - start),
      unavailable: Array.from(globalThis.__haxcmsUnavailable || []).sort(),
    };
  },
  async request({ method, url, headers, body, pageOrigin }) {
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
    out.host = "localhost";
    if (pageOrigin) {
      for (const name of ["origin", "referer"]) {
        if (out[name] && out[name].indexOf(pageOrigin) === 0) {
          out[name] = INTERNAL_ORIGIN + out[name].slice(pageOrigin.length);
        }
      }
    }
    const payload = body ? Buffer.from(body, "base64") : null;
    if (payload && out["content-length"] === undefined) {
      out["content-length"] = String(payload.length);
    }
    const response = await http.dispatch(state.app, {
      method,
      url: target,
      headers: out,
      body: payload,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body.toString("base64"),
    };
  },
  readFile({ path: file }) {
    requireBooted();
    return fs.readFileSync(file).toString("base64");
  },
  hashPassword({ password }) {
    return requireBooted().hashPassword(password);
  },
};

let queue = Promise.resolve();
globalThis.onmessage = (event) => {
  const message = event.data || {};
  queue = queue.then(async () => {
    try {
      if (!Object.prototype.hasOwnProperty.call(handlers, message.type)) {
        throw new Error("unknown message type " + message.type);
      }
      const result = await handlers[message.type](message);
      globalThis.postMessage({ id: message.id, ok: true, result });
    } catch (e) {
      globalThis.postMessage({
        id: message.id,
        ok: false,
        error: String((e && e.stack) || e),
      });
    }
  });
};
