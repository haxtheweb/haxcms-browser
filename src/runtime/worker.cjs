/**
 * haxcms-nodejs in a browser Worker (haxtheweb/issues#3331).
 *
 * The page talks to the Worker with messages: { id, type, ...args } in,
 * { id, ok, result } or { id, ok: false, error } out. Messages are handled
 * one at a time, in order.
 *
 *   boot        { snapshot, root }  load the data snapshot into the volume and
 *                                   start haxcms-nodejs with root as its
 *                                   HAXcms root
 *   createSite  { name }            HAXCMS.createSite
 *   route       { route, body }     call a site API route handler
 *   readFile    { path }            read a file from the volume (base64)
 *   hashPassword { password }       HAXCMS.hashPassword (portability check)
 *
 * Route handlers are the real haxcms-nodejs ones. The request is built here
 * as an authenticated local user: the Worker only receives messages from the
 * page that created it, on the user's own machine, so there is no remote
 * caller to authenticate.
 */
const fs = require("fs");
const path = require("path");

const routes = {
  saveOutline: () =>
    require("haxcms-nodejs/siteRoutes/v1/routes/saveOutline.js"),
};

const state = { HAXCMS: null };

function requireBooted() {
  if (!state.HAXCMS) {
    throw new Error("boot must be called first");
  }
  return state.HAXCMS;
}

function localRequest(body) {
  return {
    headers: { "x-haxcms-site-token": "local" },
    haxcmsSiteApiAuth: { authenticated: true, userName: "local" },
    body: body || {},
  };
}

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.body = obj;
      return this;
    },
  };
}

const handlers = {
  boot({ snapshot, root }) {
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
    process.chdir(haxcmsRoot);
    const { HAXCMS } = require("haxcms-nodejs/lib/HAXCMS.js");
    // there is no server boundary to check request tokens against
    HAXCMS.validateRequestToken = () => true;
    state.HAXCMS = HAXCMS;
    return {
      bootMs: Math.round(performance.now() - start),
      unavailable: Array.from(globalThis.__haxcmsUnavailable || []).sort(),
    };
  },
  async createSite({ name }) {
    const HAXCMS = requireBooted();
    await HAXCMS.createSite(name);
    const site = await HAXCMS.loadSite(name);
    return { siteDirectory: site.siteDirectory };
  },
  async route({ route, body }) {
    requireBooted();
    if (!Object.prototype.hasOwnProperty.call(routes, route)) {
      throw new Error("unknown route " + route);
    }
    const handler = routes[route]();
    const res = captureResponse();
    await handler(localRequest(body), res);
    return { status: res.statusCode, body: res.body };
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
