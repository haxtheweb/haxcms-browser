// process for the browser runtime. cwd() is the HAXcms root (or bound site)
// inside the in-memory volume; the Worker sets it on boot with chdir().
//
// uid/gid are 0 so memfs permission checks agree with the files it creates
// (memfs reads process.getuid both when creating and when checking a file).
const listeners = {};
let cwd = "/";

function hrtime(previous) {
  const now = performance.now();
  const seconds = Math.floor(now / 1e3);
  const nanos = Math.floor((now % 1e3) * 1e6);
  if (previous) {
    return [seconds - previous[0], nanos - previous[1]];
  }
  return [seconds, nanos];
}
hrtime.bigint = () => BigInt(Math.floor(performance.now() * 1e6));

const proc = {
  env: {},
  argv: [],
  execArgv: [],
  platform: "browser",
  arch: "wasm",
  browser: true,
  pid: 1,
  version: "v22.0.0",
  versions: { node: "22.0.0" },
  exitCode: 0,
  cwd: () => cwd,
  chdir: (dir) => {
    cwd = dir;
  },
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  hrtime,
  uptime: () => performance.now() / 1e3,
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
  umask: () => 0o022,
  getuid: () => 0,
  getgid: () => 0,
  on: (event, fn) => {
    if (!listeners[event]) {
      listeners[event] = [];
    }
    listeners[event].push(fn);
    return proc;
  },
  once: (event, fn) => proc.on(event, fn),
  off: () => proc,
  removeListener: () => proc,
  emit: () => false,
  emitWarning: (warning) => console.warn(warning),
  exit: (code) => {
    throw new Error("process.exit(" + code + ") called in the browser runtime");
  },
  stdout: {
    isTTY: false,
    write: (s) => console.log(String(s).replace(/\n$/, "")),
  },
  stderr: {
    isTTY: false,
    write: (s) => console.warn(String(s).replace(/\n$/, "")),
  },
};

module.exports = proc;
