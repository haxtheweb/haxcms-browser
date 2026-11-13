/**
 * Serve the assembled site locally the way GitHub Pages does, under
 * /haxcms-browser/. `npm start` builds the site first if it is missing.
 *
 *   node scripts/serve-site.mjs [port]     (default 8080)
 */
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startPagesServer } from "../test/helpers/pages-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
if (!fs.existsSync(path.join(site, "index.html"))) {
  throw new Error("site/ not found; run npm start, which builds it first");
}
const server = await startPagesServer(
  site,
  "haxcms-browser",
  Number(process.argv[2]) || 8080,
);
console.log("HAXcms in the browser: " + server.url);
