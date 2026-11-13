// Injected into the bundle: the globals Node code expects to exist.
import process from "./process.cjs";
import { Buffer } from "buffer";

// Node's setImmediate: run after the current work, before timers that are
// due later. A zero-delay timeout is the closest a Worker has.
const setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
const clearImmediate = (id) => clearTimeout(id);

// Node's Buffer has per-encoding fast paths that some packages call directly
// (busboy, which parses file uploads, uses latin1Slice and utf8Slice). The
// browser Buffer only has the general toString / write, so define them on it.
for (const [name, encoding] of [
  ["ascii", "ascii"],
  ["base64", "base64"],
  ["hex", "hex"],
  ["latin1", "latin1"],
  ["ucs2", "ucs2"],
  ["utf8", "utf8"],
]) {
  if (typeof Buffer.prototype[name + "Slice"] !== "function") {
    Buffer.prototype[name + "Slice"] = function slice(start, end) {
      return this.toString(encoding, start, end);
    };
  }
  if (typeof Buffer.prototype[name + "Write"] !== "function") {
    Buffer.prototype[name + "Write"] = function write(string, offset, length) {
      return this.write(string, offset, length, encoding);
    };
  }
}

// some packages reach for these through the global object instead of by name
for (const [name, value] of Object.entries({
  process,
  Buffer,
  setImmediate,
  clearImmediate,
})) {
  if (typeof globalThis[name] === "undefined") {
    globalThis[name] = value;
  }
}

export { process, Buffer, setImmediate, clearImmediate };
