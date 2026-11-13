/**
 * Build the demo site in one step, for a host that builds from this
 * repository itself (Vercel, Netlify, Cloudflare Pages).
 *
 *   node scripts/build-hosted.mjs
 *
 * Does what .github/workflows/pages.yml does in separate steps: fetches
 * haxcms-nodejs (main, or the branch named in HAXCMS_NODEJS_REF) into
 * .haxcms-nodejs, installs it without lifecycle scripts, builds the Worker
 * and assembles the site into site/. The site works at the root of a
 * domain or under any path.
 */
import console from "node:console";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkout = path.join(root, ".haxcms-nodejs");
const ref = process.env.HAXCMS_NODEJS_REF || "main";
const REPOSITORY = "https://github.com/haxtheweb/haxcms-nodejs.git";

function run(command, args, options) {
  console.log("> " + command + " " + args.join(" "));
  execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });
}

if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) {
  throw new Error("HAXCMS_NODEJS_REF is not a branch or tag name: " + ref);
}

fs.rmSync(checkout, { recursive: true, force: true });
run("git", [
  "clone",
  "--depth",
  "1",
  "--branch",
  ref,
  "--",
  REPOSITORY,
  checkout,
]);
run(
  "yarn",
  ["install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"],
  { cwd: checkout },
);

const env = {
  ...process.env,
  HAXCMS_NODEJS_SRC: path.join(checkout, "src"),
};
run(process.execPath, ["scripts/build.mjs"], { env });
run(process.execPath, ["scripts/bundle-license-check.mjs"], { env });
run(process.execPath, ["scripts/build-site.mjs", "--out", "site"], { env });
console.log("Site is in site/");
