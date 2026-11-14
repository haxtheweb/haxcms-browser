/**
 * Lists what an offline copy of the site is made of
 * (haxtheweb/issues#3331). Called by build-site.mjs once the site folder is
 * complete; src/site/offline.js reads the result in the browser when someone
 * installs the app or asks for offline use.
 *
 *   offline-manifest.json        { format, build, bytes, languages, files }
 *                                files: { "<path>": ["<hash>", <bytes>] }
 *   offline-locales/<lang>.json  { files } for one language's translations
 *
 * `build` names this exact set of files: it changes when any file does, and
 * only then (version.json, which records when the site was assembled, does
 * not count). A copy saved in a browser is one build, whole.
 *
 * What is left out: translations go in per-language lists, because all of
 * them together are most of the front end (about 42,000 files) and a browser
 * only needs the languages its user reads. Source maps, type definitions and
 * notes for developers are not needed to run. sw.js is kept by the browser
 * itself, reset.html must always come from the web server, and these lists
 * are what the copy is checked against.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const OFFLINE_FORMAT = 1;
const MANIFEST = "offline-manifest.json";
const LOCALES = "offline-locales";
// never part of a copy (see above)
const NOT_COPIED = [MANIFEST, "sw.js", "reset.html", ".nojekyll"];
const NOT_NEEDED = /\.(map|md|ts|sh|header)$/;
// copied, but a new one alone is not a new build
const NOT_FINGERPRINTED = ["version.json"];
// "<name>.<language>.json" in a locales folder: "es", "zh_CN", "pt-BR"
const LOCALE_FILE =
  /\/locales\/[^/]+\.([A-Za-z]{2,3}(?:[_-][A-Za-z]{2,4})?)\.json$/;

// every file under dir, as paths relative to it with forward slashes;
// follows the link build-site.mjs --link makes for public/
function walk(dir, prefix, found) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const relative = prefix ? prefix + "/" + name : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, relative, found);
    } else if (stat.isFile()) {
      found.push({ path: relative, full, bytes: stat.size });
    }
  }
  return found;
}

function hashFile(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")
    .slice(0, 16);
}

export function writeOfflineManifest(out) {
  fs.rmSync(path.join(out, LOCALES), { recursive: true, force: true });
  fs.rmSync(path.join(out, MANIFEST), { force: true });
  const files = {};
  const locales = {};
  const all = crypto.createHash("sha256");
  let bytes = 0;
  for (const file of walk(out, "", [])) {
    if (NOT_COPIED.includes(file.path) || NOT_NEEDED.test(file.path)) {
      continue;
    }
    const entry = [hashFile(file.full), file.bytes];
    if (!NOT_FINGERPRINTED.includes(file.path)) {
      all.update(file.path + "\n" + entry[0] + "\n");
    }
    const locale = LOCALE_FILE.exec(file.path);
    if (locale) {
      const language = locale[1];
      if (!locales[language]) {
        locales[language] = {};
      }
      locales[language][file.path] = entry;
    } else {
      files[file.path] = entry;
      bytes += file.bytes;
    }
  }
  const languages = Object.keys(locales).sort();
  fs.mkdirSync(path.join(out, LOCALES), { recursive: true });
  for (const language of languages) {
    fs.writeFileSync(
      path.join(out, LOCALES, language + ".json"),
      JSON.stringify({ files: locales[language] }),
    );
  }
  const manifest = {
    format: OFFLINE_FORMAT,
    build: all.digest("hex").slice(0, 16),
    bytes,
    languages,
    files,
  };
  fs.writeFileSync(path.join(out, MANIFEST), JSON.stringify(manifest));
  return manifest;
}
