/**
 * Assemble the static site that hosts HAXcms in the browser (the GitHub
 * Pages demo). Run `npm run build` first.
 *
 *   node scripts/build-site.mjs [--out site] [--link]
 *
 * Output:
 *   index.html, shell.js, shell.css   the host page (src/site)
 *   sw.js                             the service worker that relays requests
 *   haxcms-worker.js                  the Worker bundle (dist)
 *   haxcms-snapshot.json              its data snapshot (dist)
 *   public/                           haxcms-nodejs's front-end build, served
 *                                     as plain static files
 *   version.json                      which commits this was built from
 *   .nojekyll
 *
 * The front end comes from the same haxcms-nodejs the Worker was built from
 * (HAXCMS_NODEJS_SRC, or the installed package), so the editor and the
 * backend always match. --link symlinks public/ instead of copying its
 * ~44,000 files, for local use.
 */
import console from "node:console";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = path.resolve(root, outIndex !== -1 ? args[outIndex + 1] : "site");
const link = args.includes("--link");
const SRC = process.env.HAXCMS_NODEJS_SRC
  ? path.resolve(process.env.HAXCMS_NODEJS_SRC)
  : path.join(
      path.dirname(require.resolve("@haxtheweb/haxcms-nodejs/package.json")),
      "dist",
    );

function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir].concat(args), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function commit(dir) {
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

// haxcms-nodejs: its commit when built from a checkout, its package version
// when built from the installed package (which sits inside this repo's tree)
function haxcmsNodejsVersion() {
  const top = git(SRC, ["rev-parse", "--show-toplevel"]);
  if (top && path.resolve(top) !== root) {
    return commit(SRC);
  }
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"),
    );
    return pkg.version + " (npm)";
  } catch {
    return "";
  }
}

// recursive copy (fs.cpSync needs a newer Node than this package supports)
function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    if (skip && skip(source)) {
      continue;
    }
    const target = path.join(to, name);
    if (fs.statSync(source).isDirectory()) {
      copyDir(source, target, skip);
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

const dist = path.join(root, "dist");
for (const file of ["haxcms-worker.js", "haxcms-snapshot.json"]) {
  if (!fs.existsSync(path.join(dist, file))) {
    throw new Error(`dist/${file} not found; run npm run build first`);
  }
}
const publicDir = path.join(SRC, "public");
if (!fs.existsSync(path.join(publicDir, "build"))) {
  throw new Error("haxcms-nodejs front-end build not found at " + publicDir);
}
// only ever clear a folder this script made
if (fs.existsSync(out) && !fs.existsSync(path.join(out, "haxcms-worker.js"))) {
  if (fs.readdirSync(out).length > 0) {
    throw new Error(out + " exists and is not a haxcms-browser site folder");
  }
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

copyDir(path.join(root, "src/site"), out);
for (const file of ["haxcms-worker.js", "haxcms-snapshot.json"]) {
  fs.copyFileSync(path.join(dist, file), path.join(out, file));
}
if (link) {
  fs.symlinkSync(publicDir, path.join(out, "public"), "dir");
} else {
  copyDir(
    publicDir,
    path.join(out, "public"),
    // the dashboard page itself is served by the Worker, not as a static file
    (source) => source === path.join(publicDir, "index.html"),
  );
}
fs.writeFileSync(
  path.join(out, "version.json"),
  JSON.stringify({
    haxcmsBrowser: commit(root),
    haxcmsNodejs: haxcmsNodejsVersion(),
    built: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  }),
);
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`site written to ${out}${link ? " (public/ linked)" : ""}`);
