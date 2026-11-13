/**
 * Bundle haxcms-nodejs to run in a browser Worker (haxtheweb/issues#3331).
 *
 *   node scripts/build.mjs
 *       builds against the installed @haxtheweb/haxcms-nodejs (its dist/)
 *   HAXCMS_NODEJS_SRC=/path/to/haxcms-nodejs/src node scripts/build.mjs
 *       builds against another checkout, e.g. haxcms-nodejs main in CI
 *
 * Output (dist/):
 *   haxcms-worker.js     the Worker: haxcms-nodejs + browser shims
 *   haxcms-snapshot.json the static files haxcms-nodejs reads from disk at
 *                        runtime (boilerplate, coreConfig, lib data files),
 *                        loaded into the in-memory volume on boot
 *   meta.json            esbuild metafile, for size reports
 *
 * Nothing in haxcms-nodejs is copied or edited: Node built-ins are swapped
 * for browser versions at bundle time, and packages that can only run on a
 * server are replaced with a stub that throws when used. The stub list is
 * reported by the Worker on boot so the UI can say what is unavailable.
 */
import * as esbuild from "esbuild";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.HAXCMS_NODEJS_SRC
  ? path.resolve(process.env.HAXCMS_NODEJS_SRC)
  : path.join(
      path.dirname(require.resolve("@haxtheweb/haxcms-nodejs/package.json")),
      "dist",
    );
const SHIMS = path.join(root, "src/runtime/shims");
// @jspm/core's exports map sends the "node" condition to its Node builds, so
// find the package folder and point at nodelibs/browser/ directly.
function packageRoot(resolved) {
  let dir = path.dirname(resolved);
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    dir = path.dirname(dir);
  }
  return dir;
}
const JSPM = path.join(
  packageRoot(require.resolve("@jspm/core/nodelibs/path")),
  "nodelibs/browser/",
);

// Node built-ins: browser implementations from @jspm/core (Apache-2.0), or
// local shims where the worker needs different behavior.
const builtins = {
  fs: path.join(SHIMS, "fs.cjs"),
  "graceful-fs": path.join(SHIMS, "fs.cjs"),
  "fs/promises": path.join(SHIMS, "fs-promises.cjs"),
  os: path.join(SHIMS, "os.cjs"),
  process: path.join(SHIMS, "process.cjs"),
  async_hooks: path.join(SHIMS, "async_hooks.cjs"),
  crypto: path.join(SHIMS, "crypto.cjs"),
  http: path.join(SHIMS, "http.cjs"),
  tty: path.join(SHIMS, "tty.cjs"),
  net: path.join(SHIMS, "net.cjs"),
  path: JSPM + "path.js",
  events: JSPM + "events.js",
  stream: JSPM + "stream.js",
  util: JSPM + "util.js",
  buffer: JSPM + "buffer.js",
  url: JSPM + "url.js",
  querystring: JSPM + "querystring.js",
  string_decoder: JSPM + "string_decoder.js",
  assert: JSPM + "assert.js",
  constants: JSPM + "constants.js",
  zlib: JSPM + "zlib.js",
  timers: JSPM + "timers.js",
};
// Node built-ins with no browser equivalent.
const unavailableBuiltins = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "http2",
  "https",
  "inspector",
  "module",
  "perf_hooks",
  "readline",
  "tls",
  "v8",
  "vm",
  "worker_threads",
]);
// Packages that need a server, a native binary or a real DOM. Stubbed until
// the runtime has a browser replacement (see README "What is not available").
const unavailablePackages = [
  "chokidar",
  "epub-gen-memory",
  "git-interface",
  "html-to-docx",
  "mammoth",
  "open",
  "puppeteer-core",
  "sharp",
  "text-readability",
  "unpdf",
  "ws",
];

function isUnavailablePackage(id) {
  return unavailablePackages.some((p) => id === p || id.startsWith(p + "/"));
}

const STUB_SOURCE = (name) => `const name = ${JSON.stringify(name)};
const used = () => { throw new Error(name + " is not available in the browser runtime"); };
if (!globalThis.__haxcmsUnavailable) { globalThis.__haxcmsUnavailable = new Set(); }
globalThis.__haxcmsUnavailable.add(name);
// Loading the module works (property reads, "class X extends stub"); calling
// or constructing anything from it throws.
const stub = new Proxy(function () {}, {
  get: (t, key) => {
    if (key === "__esModule") { return false; }
    if (key === "then") { return undefined; }
    if (key === Symbol.toPrimitive) { return () => name; }
    return stub;
  },
  apply: used,
  construct: used,
});
module.exports = stub;
`;

const haxcmsBrowserPlugin = {
  name: "haxcms-browser",
  setup(build) {
    // shims reach a @jspm/core module directly with "jspm:<name>"
    build.onResolve({ filter: /^jspm:/ }, (args) => ({
      path: JSPM + args.path.slice(5) + ".js",
      namespace: "jspm",
    }));
    build.onResolve({ filter: /.*/ }, (args) => {
      const id = args.path.replace(/^node:/, "");
      if (builtins[id]) {
        const target = builtins[id];
        // @jspm/core modules are ESM with a default export, but CommonJS
        // callers expect the default itself (util.inherits(X, require("stream"))).
        if (target.startsWith(JSPM) && args.namespace !== "jspm") {
          return { path: target, namespace: "jspm" };
        }
        return { path: target };
      }
      if (
        unavailableBuiltins.has(id.split("/")[0]) ||
        isUnavailablePackage(id)
      ) {
        return { path: id, namespace: "unavailable" };
      }
      return null;
    });
    build.onResolve({ filter: /.*/, namespace: "jspm" }, (args) => ({
      path: args.path,
    }));
    build.onLoad({ filter: /.*/, namespace: "jspm" }, (args) => ({
      loader: "js",
      resolveDir: path.dirname(args.path),
      contents: `const m = require(${JSON.stringify(args.path)});
const d = m.default || m;
if (d !== m) {
  for (const k of Object.keys(m)) {
    if (k !== "default" && !(k in d)) { try { d[k] = m[k]; } catch (e) { /* read-only */ } }
  }
}
module.exports = d;`,
    }));
    build.onLoad({ filter: /.*/, namespace: "unavailable" }, (args) => ({
      loader: "js",
      contents: STUB_SOURCE(args.path),
    }));
    // Every haxcms-nodejs file gets a stable __dirname/__filename inside the
    // volume (/app/...), which is where the snapshot puts its data files.
    const srcPrefix = SRC + path.sep;
    build.onLoad({ filter: /\.c?js$/ }, (args) => {
      if (!args.path.startsWith(srcPrefix)) {
        return null;
      }
      const rel =
        "/app/" + path.relative(SRC, args.path).split(path.sep).join("/");
      return {
        loader: "js",
        contents:
          `var __filename = ${JSON.stringify(rel)}, __dirname = ${JSON.stringify(path.posix.dirname(rel))};\n` +
          // a #! line is only valid as the very first line
          fs.readFileSync(args.path, "utf8").replace(/^#![^\n]*/, ""),
      };
    });
  },
};

// The data files haxcms-nodejs reads at runtime, keyed by volume path.
function snapshot() {
  const out = {};
  const add = (abs) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        add(path.join(abs, name));
      }
      return;
    }
    const rel = path.relative(SRC, abs).split(path.sep).join("/");
    out["/app/" + rel] = fs.readFileSync(abs).toString("base64");
  };
  add(path.join(SRC, "boilerplate"));
  add(path.join(SRC, "coreConfig"));
  // the OpenAPI specs the API serves and validates against
  if (fs.existsSync(path.join(SRC, "openapi"))) {
    add(path.join(SRC, "openapi"));
  }
  // the dashboard page and its small assets. The front-end build itself
  // (public/build, the wc-registry files) is far too big for the volume; a
  // host page serves it as static files instead (see scripts/build-site.mjs).
  for (const name of ["index.html", "manifest.json", "assets"]) {
    const file = path.join(SRC, "public", name);
    if (fs.existsSync(file)) {
      add(file);
    }
  }
  for (const name of fs.readdirSync(path.join(SRC, "lib"))) {
    if (/\.(json|ya?ml)$/.test(name)) {
      add(path.join(SRC, "lib", name));
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(path.join(SRC, "lib", "HAXCMS.js"))) {
    throw new Error("haxcms-nodejs source not found at " + SRC);
  }
  const dist = path.join(root, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "haxcms-snapshot.json"),
    JSON.stringify(snapshot()),
  );
  const result = await esbuild.build({
    entryPoints: [path.join(root, "src/runtime/worker.cjs")],
    outfile: path.join(dist, "haxcms-worker.js"),
    bundle: true,
    format: "iife",
    // "neutral" + main fields: use each package's Node entry, not its
    // "browser" build (those assume a window, which a Worker does not have).
    platform: "neutral",
    mainFields: ["main", "module"],
    conditions: ["node", "require", "default"],
    target: "es2022",
    minify: process.env.HAXCMS_BROWSER_MINIFY !== "0",
    metafile: true,
    logLevel: "warning",
    alias: { "haxcms-nodejs": SRC },
    // NODE_ENV stays unset, like `hax serve`: haxcms-nodejs treats
    // production as a server deployment (and refuses local mode there).
    define: {
      global: "globalThis",
    },
    inject: [path.join(SHIMS, "globals.mjs")],
    plugins: [haxcmsBrowserPlugin],
  });
  fs.writeFileSync(
    path.join(dist, "meta.json"),
    JSON.stringify(result.metafile),
  );
  const kb = (file) =>
    (fs.statSync(path.join(dist, file)).size / 1024).toFixed(0) + " KB";
  console.log(
    `haxcms-worker.js ${kb("haxcms-worker.js")}, haxcms-snapshot.json ${kb("haxcms-snapshot.json")} (from ${SRC})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
