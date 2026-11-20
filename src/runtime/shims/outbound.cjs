// Outbound requests for the browser runtime (haxtheweb/issues#3389): the
// client half of http / https, and the names dns refuses. haxcms-nodejs
// reaches the web only through safeFetch (lib/safeFetch.js): it resolves a
// name with dns, refuses private and reserved addresses, then makes one
// http(s).request per hop. Here the browser's own fetch makes the request.
//
// What holds in the browser, and what does not:
// - safeFetch's checks still run first: its scheme, size cap, timeout and
//   private-address check on IP literals are haxcms-nodejs's own code.
// - A browser cannot resolve a name to an address, so dns (shims/dns.cjs)
//   refuses names that only mean something on this device or its local
//   network, and answers every other name with a stand-in public address.
//   The stand-in is never connected to: requests below go to the hostname.
// - The browser enforces CORS on every request, so only sites that allow
//   requests from other websites answer, and it never sends this page's
//   cookies or credentials (credentials: "omit").
// - Redirects are followed by the browser, which applies CORS (and, in
//   Chromium, Private Network Access) to every hop. The address that finally
//   answered is checked against the same local-name and IP rules before any
//   of its body is read.
const { EventEmitter } = require("events");
const net = require("net");

// Name endings that only resolve on this device or a local network.
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
];

function bareHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

// true for a name that means this device or a local network: such names
// are refused rather than given a stand-in public address
function isLocalName(hostname) {
  const host = bareHost(hostname);
  if (host === "" || host === "localhost") {
    return true;
  }
  if (net.isIP(host)) {
    return false;
  }
  // a single label ("router", "nas") is resolved by a local search domain
  if (host.indexOf(".") === -1) {
    return true;
  }
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// The private / reserved check haxcms-nodejs applies to resolved addresses,
// for the address that finally answered after redirects. Loaded on first
// use: HAXCMSFile is part of the bundle, and this shim loads before it.
function isPrivateAddress(host) {
  const HAXCMSFile = require("haxcms-nodejs/lib/HAXCMSFile.js");
  return HAXCMSFile.isPrivateOrReservedIP(host);
}

function blockedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const UNREACHABLE =
  "This web address can't be reached from HAX in the browser: the site " +
  "doesn't allow requests from other websites (CORS), or it can't be " +
  "reached right now. Download the file and upload it instead.";

// headers fetch sets itself or a browser refuses to send
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

// The response a request callback receives: the parts of IncomingMessage
// safeFetch reads (statusCode, statusMessage, headers, data/end/error, destroy).
class OutboundResponse extends EventEmitter {
  constructor(response, cancel) {
    super();
    this.statusCode = response.status;
    this.statusMessage = response.statusText || "";
    this.headers = {};
    response.headers.forEach((value, name) => {
      this.headers[name.toLowerCase()] = value;
    });
    this.url = response.url;
    this.destroyed = false;
    this._cancel = cancel;
  }

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this._cancel();
    }
    return this;
  }
}

// The request http(s).request returns: write() collects the body, end()
// sends it, destroy() aborts.
class OutboundRequest extends EventEmitter {
  constructor(protocol, options, callback) {
    super();
    this.protocol = protocol;
    this.options = options || {};
    this.method = String(this.options.method || "GET").toUpperCase();
    this.destroyed = false;
    this._chunks = [];
    this._controller = new AbortController();
    if (typeof callback === "function") {
      this.once("response", callback);
    }
  }

  // The address the caller asked for. safeFetch connects to a pre-resolved
  // address and keeps the real name in the Host header (and servername for
  // TLS); that name is what the browser is asked for.
  url() {
    const opts = this.options;
    const headers = opts.headers || {};
    let authority = "";
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "host") {
        authority = String(headers[name]);
      }
    }
    if (!authority) {
      const host = opts.servername || opts.hostname || opts.host || "";
      const port = opts.port ? ":" + opts.port : "";
      authority = (net.isIP(host) === 6 ? "[" + host + "]" : host) + port;
    }
    return new URL(this.protocol + "//" + authority + (opts.path || "/"));
  }

  write(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this._chunks.push(Buffer.from(chunk));
    }
    return true;
  }

  end(chunk) {
    this.write(chunk);
    // let the caller attach its listeners before anything is emitted
    Promise.resolve().then(() => this._send());
    return this;
  }

  destroy(err) {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    this._controller.abort();
    if (err) {
      this.emit("error", err);
    }
    return this;
  }

  setTimeout() {
    return this;
  }

  async _send() {
    if (this.destroyed) {
      return;
    }
    let target;
    try {
      target = this.url();
    } catch {
      this.emit("error", blockedError("Invalid URL", "SSRF_INVALID_URL"));
      return;
    }
    if (isLocalName(target.hostname)) {
      this.emit(
        "error",
        blockedError(
          "URL target is on this device or a local network",
          "SSRF_PRIVATE",
        ),
      );
      return;
    }
    const headers = new Headers();
    const given = this.options.headers || {};
    for (const name of Object.keys(given)) {
      if (!SKIP_HEADERS.has(name.toLowerCase())) {
        const value = given[name];
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const init = {
      method: this.method,
      headers,
      redirect: "follow",
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: this._controller.signal,
    };
    if (
      this._chunks.length &&
      this.method !== "GET" &&
      this.method !== "HEAD"
    ) {
      init.body = Buffer.concat(this._chunks);
    }
    let response;
    try {
      response = await globalThis.fetch(target.href, init);
    } catch (e) {
      if (!this.destroyed) {
        const err = blockedError(UNREACHABLE, "BROWSER_FETCH_BLOCKED");
        err.cause = e;
        this.emit("error", err);
      }
      return;
    }
    if (this.destroyed) {
      return;
    }
    // where a redirect led: the same rules as the address asked for
    if (response.redirected && response.url) {
      const landed = new URL(response.url);
      const host = bareHost(landed.hostname);
      if (
        isLocalName(host) ||
        (net.isIP(host) && isPrivateAddress(host)) ||
        (landed.protocol !== "http:" && landed.protocol !== "https:")
      ) {
        this._controller.abort();
        this.emit(
          "error",
          blockedError(
            "Redirect target is a private, reserved, loopback, link-local, or local-network address",
            "SSRF_PRIVATE",
          ),
        );
        return;
      }
    }
    const reader = response.body ? response.body.getReader() : null;
    const incoming = new OutboundResponse(response, () => {
      this._controller.abort();
      if (reader) {
        reader.cancel().catch(() => {});
      }
    });
    this.emit("response", incoming);
    if (!reader) {
      if (!incoming.destroyed) {
        incoming.emit("end");
      }
      return;
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (incoming.destroyed) {
          return;
        }
        if (done) {
          break;
        }
        incoming.emit("data", Buffer.from(value));
      }
    } catch (e) {
      if (!incoming.destroyed) {
        incoming.emit("error", e);
      }
      return;
    }
    if (!incoming.destroyed) {
      incoming.emit("end");
    }
  }
}

// request(options[, callback]) / request(url[, options][, callback])
function client(protocol) {
  function request(input, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    if (typeof input === "string" || input instanceof URL) {
      const url = new URL(String(input));
      opts = Object.assign(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port,
          path: url.pathname + url.search,
        },
        opts || {},
      );
      return new OutboundRequest(url.protocol, opts, cb);
    }
    return new OutboundRequest(protocol, input || {}, cb);
  }
  function get(input, options, callback) {
    const req = request(input, options, callback);
    req.end();
    return req;
  }
  return { request, get };
}

module.exports = { client, isLocalName, bareHost };
