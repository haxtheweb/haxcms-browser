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

// Steps that use the network (fetching haxcms-nodejs and its packages) fail
// now and then on a build host; try them again before giving up.
function runWithRetries(step, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      step();
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      console.log(
        "That step failed (" +
          String((error && error.message) || error).split("\n")[0] +
          "); trying again, attempt " +
          (attempt + 1) +
          " of " +
          attempts,
      );
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        attempt * 3000,
      );
    }
  }
}

if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) {
  throw new Error("HAXCMS_NODEJS_REF is not a branch or tag name: " + ref);
}

runWithRetries(() => {
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
});
runWithRetries(() =>
  run(
    "yarn",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--non-interactive",
      "--network-timeout",
      "120000",
    ],
    { cwd: checkout },
  ),
);

const env = {
  ...process.env,
  HAXCMS_NODEJS_SRC: path.join(checkout, "src"),
};
run(process.execPath, ["scripts/build.mjs"], { env });
run(process.execPath, ["scripts/bundle-license-check.mjs"], { env });
// A build host can hand back part of an earlier site/ from its cache (Vercel
// keeps every node_modules folder, and the front-end build under
// site/public is full of them). build-site.mjs refuses to clear a folder it
// does not recognise as its own, so clear this one here: in a hosted build
// site/ is only ever this script's output.
fs.rmSync(path.join(root, "site"), { recursive: true, force: true });
run(process.execPath, ["scripts/build-site.mjs", "--out", "site"], { env });
console.log("Site is in site/");
