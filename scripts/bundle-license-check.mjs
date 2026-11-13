/**
 * Bundle license check: every package whose code is inside
 * dist/haxcms-worker.js must have an Apache-2.0-compatible permissive
 * license. This is stricter than scripts/license-check.mjs (which covers the
 * whole dependency tree and allows reviewed exceptions): the Worker bundle
 * ships the code, so there are no exceptions here.
 *
 *   node scripts/bundle-license-check.mjs     (after npm run build)
 *
 * Reads the packages from dist/meta.json (the esbuild metafile).
 * Exit code 1 if any bundled package is not on the allow list.
 */
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

// "(MIT OR Apache-2.0)" passes if any option is allowed; "A AND B" needs both.
function allowed(expression) {
  const expr = String(expression || "")
    .replace(/[()]/g, "")
    .trim();
  if (!expr) {
    return false;
  }
  return expr
    .split(/\s+OR\s+/)
    .some((option) =>
      option.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())),
    );
}

function licenseOf(pkgJson) {
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
  if (typeof pkg.license === "string") {
    return { name: pkg.name, license: pkg.license };
  }
  if (pkg.license && pkg.license.type) {
    return { name: pkg.name, license: pkg.license.type };
  }
  if (Array.isArray(pkg.licenses)) {
    return {
      name: pkg.name,
      license: pkg.licenses.map((l) => l.type || l).join(" OR "),
    };
  }
  return { name: pkg.name, license: "" };
}

// the package root that owns a bundled file: the folder after the last
// node_modules/ (two segments for a scoped package)
function packageDir(file) {
  const abs = path.resolve(root, file);
  const marker = path.sep + "node_modules" + path.sep;
  const at = abs.lastIndexOf(marker);
  if (at === -1) {
    return null;
  }
  const rest = abs.slice(at + marker.length).split(path.sep);
  const segments = rest[0].startsWith("@") ? 2 : 1;
  return (
    abs.slice(0, at + marker.length) + rest.slice(0, segments).join(path.sep)
  );
}

const metaFile = path.join(root, "dist", "meta.json");
if (!fs.existsSync(metaFile)) {
  throw new Error("dist/meta.json not found; run npm run build first");
}
const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
const packages = new Map();
for (const input of Object.keys(meta.inputs)) {
  // inputs from plugin namespaces look like "jspm:/abs/path" or "unavailable:sharp"
  const file = input.replace(/^[a-z-]+:/, "");
  const dir = packageDir(file);
  if (dir && !packages.has(dir)) {
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      packages.set(dir, licenseOf(pkgJson));
    }
  }
}
const failures = [...packages.values()].filter((p) => !allowed(p.license));
console.log(`Bundle license check: ${packages.size} bundled package(s).`);
for (const f of failures) {
  console.error(
    `not allowed in the Worker bundle: ${f.name} (${f.license || "no license"})`,
  );
}
process.exitCode = failures.length ? 1 : 0;
