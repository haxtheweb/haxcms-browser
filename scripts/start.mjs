/**
 * Build the demo if it has not been built yet, then serve it.
 *
 *   npm start                 build once (several minutes), then serve
 *   npm start -- --rebuild    build again first
 *   npm start -- 9000         another port (default 8080)
 *
 * With HAXCMS_NODEJS_SRC set, the site is built from that haxcms-nodejs
 * checkout. Without it, haxcms-nodejs main is fetched into .haxcms-nodejs
 * (npm run build:hosted).
 */
import console from "node:console";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rebuild = args.includes("--rebuild");
const port = args.find((arg) => /^\d+$/.test(arg));

function run(script, scriptArgs = []) {
  execFileSync(
    process.execPath,
    [path.join("scripts", script), ...scriptArgs],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
}

if (rebuild || !fs.existsSync(path.join(root, "site", "index.html"))) {
  if (process.env.HAXCMS_NODEJS_SRC) {
    console.log("Building from " + process.env.HAXCMS_NODEJS_SRC);
    run("build.mjs");
    run("build-site.mjs", ["--link"]);
  } else {
    console.log("Building the demo (first run takes several minutes)...");
    run("build-hosted.mjs");
  }
}
run("serve-site.mjs", port ? [port] : []);
