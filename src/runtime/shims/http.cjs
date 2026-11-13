// http for the browser runtime: just enough of Node's http for Express (and
// the middleware haxcms-nodejs uses) to run when the Worker hands it a
// request. There is no network server: createServer throws, and requests come
// in through dispatch() below.
const { EventEmitter } = require("events");
const { Readable, Writable } = require("stream");

const STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
// where a request keeps its body until it is read. Not a plain property:
// middleware owns names like req._body (body-parser's "already parsed" flag)
const PAYLOAD = Symbol("payload");
const METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

// the "connection" a request arrives on: always local, never encrypted
class LocalSocket extends EventEmitter {
  constructor() {
    super();
    this.remoteAddress = "127.0.0.1";
    this.remotePort = 0;
    this.localAddress = "127.0.0.1";
    this.localPort = 0;
    this.encrypted = false;
    this.readable = true;
    this.writable = true;
    this.destroyed = false;
  }
  address() {
    return { address: "127.0.0.1", family: "IPv4", port: 0 };
  }
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.writable = false;
    return this;
  }
  end() {}
}

class IncomingMessage extends Readable {
  constructor(socket, init) {
    super();
    const options = init || {};
    this.socket = socket;
    this.connection = socket;
    this.method = (options.method || "GET").toUpperCase();
    this.url = options.url || "/";
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.headers = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.aborted = false;
    this.complete = false;
    const headers = options.headers || {};
    for (const name of Object.keys(headers)) {
      const value = String(headers[name]);
      this.headers[name.toLowerCase()] = value;
      this.rawHeaders.push(name, value);
    }
    this[PAYLOAD] = options.body || null;
  }
  _read() {
    const payload = this[PAYLOAD];
    this[PAYLOAD] = null;
    if (payload && payload.length) {
      this.push(payload);
    }
    this.complete = true;
    this.push(null);
  }
  setTimeout() {
    return this;
  }
}

class ServerResponse extends Writable {
  constructor(req) {
    super();
    this.req = req;
    this.socket = req ? req.socket : null;
    this.connection = this.socket;
    this.statusCode = 200;
    this.statusMessage = "";
    this.sendDate = true;
    this.headersSent = false;
    this.finished = false;
    this.chunkedEncoding = false;
    this._headerMap = new Map();
    this._chunks = [];
    this.on("finish", () => {
      this.finished = true;
    });
  }
  setHeader(name, value) {
    if (this.headersSent) {
      throw new Error("Cannot set headers after they are sent to the client");
    }
    this._headerMap.set(String(name).toLowerCase(), [String(name), value]);
    return this;
  }
  appendHeader(name, value) {
    const current = this.getHeader(name);
    if (current === undefined) {
      return this.setHeader(name, value);
    }
    return this.setHeader(name, [].concat(current, value));
  }
  getHeader(name) {
    const entry = this._headerMap.get(String(name).toLowerCase());
    return entry ? entry[1] : undefined;
  }
  getHeaders() {
    const out = {};
    for (const [key, entry] of this._headerMap) {
      out[key] = entry[1];
    }
    return out;
  }
  getHeaderNames() {
    return Array.from(this._headerMap.keys());
  }
  hasHeader(name) {
    return this._headerMap.has(String(name).toLowerCase());
  }
  removeHeader(name) {
    if (this.headersSent) {
      throw new Error(
        "Cannot remove headers after they are sent to the client",
      );
    }
    this._headerMap.delete(String(name).toLowerCase());
  }
  writeHead(statusCode, statusMessage, headers) {
    let message = statusMessage;
    let extra = headers;
    if (typeof message === "object" && message !== null) {
      extra = message;
      message = undefined;
    }
    this.statusCode = statusCode;
    if (typeof message === "string") {
      this.statusMessage = message;
    }
    if (extra) {
      for (const name of Object.keys(extra)) {
        this.setHeader(name, extra[name]);
      }
    }
    this.headersSent = true;
    return this;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  writeContinue() {}
  assignSocket() {}
  detachSocket() {}
  setTimeout() {
    return this;
  }
  _write(chunk, encoding, callback) {
    this.headersSent = true;
    this._chunks.push(
      typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk),
    );
    callback();
  }
  _final(callback) {
    this.headersSent = true;
    callback();
  }
}

function createServer() {
  throw new Error(
    "http.createServer is not available in the browser runtime; requests are dispatched to the app directly",
  );
}

// Run one request through a Node-style handler (an Express app) and resolve
// with the full response once it finishes.
function dispatch(handler, init) {
  return new Promise((resolve, reject) => {
    const socket = new LocalSocket();
    const req = new IncomingMessage(socket, init);
    const res = new ServerResponse(req);
    res.on("finish", () => {
      const headers = {};
      for (const [key, entry] of res._headerMap) {
        headers[key] = Array.isArray(entry[1])
          ? entry[1].map(String)
          : String(entry[1]);
      }
      resolve({
        status: res.statusCode,
        statusText: res.statusMessage || STATUS_CODES[res.statusCode] || "",
        headers,
        body: Buffer.concat(res._chunks),
      });
    });
    res.on("error", reject);
    try {
      handler(req, res);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  METHODS,
  STATUS_CODES,
  IncomingMessage,
  ServerResponse,
  Agent: class Agent {},
  globalAgent: {},
  createServer,
  dispatch,
};
