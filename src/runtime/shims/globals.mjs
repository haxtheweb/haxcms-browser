// Injected into the bundle: the globals Node code expects to exist.
import process from "./process.cjs";
import { Buffer } from "buffer";

// Node's setImmediate: run after the current work, before timers that are
// due later. A zero-delay timeout is the closest a Worker has.
const setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
const clearImmediate = (id) => clearTimeout(id);

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
