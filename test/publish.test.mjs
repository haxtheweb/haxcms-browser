// Packing a site for a static host (src/runtime/publish.cjs): the files the
// HAX CLI publishes, as a gzipped tarball Surge accepts. Runs on Node with
// memfs; the tarball is checked by unpacking it with the system's tar.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import nodeFs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { Volume, createFsFromVolume } from "memfs";

const require = createRequire(import.meta.url);
const publish = require("../src/runtime/publish.cjs");

const SITES = "/haxcms/_sites";
const SITE = SITES + "/one";

function seed() {
  const fs = createFsFromVolume(new Volume());
  const files = {
    "site.json": '{"title":"Site One"}',
    "index.html": "<p>server index</p>",
    "ghpages.html": "<p>static index</p>",
    "pages/a/index.html": "<p>a</p>",
    "files/photo.jpg": "jpeg",
    "custom/build/custom.js": "custom",
    "assets/manifest.json": "{}",
    "assets/babel-top.js": "babel",
    "wc-registry.json": "{}",
    ".htaccess": "deny",
    ".github/workflows/x.yml": "x",
    "node_modules/x/index.js": "x",
    "pages/b/node_modules/y.js": "y",
    "dist/out.js": "dist",
    "logs/a.txt": "log",
    "debug.log": "log",
    CNAME: "one-abc123.surge.sh\n",
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.posix.dirname(SITE + "/" + file), { recursive: true });
    fs.writeFileSync(SITE + "/" + file, content);
  }
  // the shared front-end build haxcms-nodejs links into each site
  fs.mkdirSync("/haxcms/build/es6", { recursive: true });
  fs.writeFileSync("/haxcms/build/es6/x.js", "build");
  fs.symlinkSync("/haxcms/build", SITE + "/build");
  fs.symlinkSync("/haxcms/build/es6/x.js", SITE + "/linked.js");
  return fs;
}

test("only what the HAX CLI publishes is packed, with ghpages.html as index.html", () => {
  const fs = seed();
  const files = publish.collectSiteFiles(fs, path.posix, SITE);
  assert.deepEqual(
    files.map((file) => file.path),
    [
      "CNAME",
      "assets/manifest.json",
      "custom/build/custom.js",
      "files/photo.jpg",
      "ghpages.html",
      "index.html",
      "pages/a/index.html",
      "site.json",
    ],
  );
  const index = files.find((file) => file.path === "index.html");
  assert.equal(Buffer.from(index.bytes).toString(), "<p>static index</p>");
  // the site itself is not changed
  assert.equal(
    fs.readFileSync(SITE + "/index.html", "utf8"),
    "<p>server index</p>",
  );
});

test("a site without ghpages.html keeps its index.html", () => {
  const fs = seed();
  fs.unlinkSync(SITE + "/ghpages.html");
  const files = publish.collectSiteFiles(fs, path.posix, SITE);
  const index = files.find((file) => file.path === "index.html");
  assert.equal(Buffer.from(index.bytes).toString(), "<p>server index</p>");
});

test("the tarball unpacks to the same files, under ./", async () => {
  const fs = seed();
  const long =
    "pages/" + "a-very-long-folder-name-for-a-page/".repeat(4) + "index.html";
  fs.mkdirSync(path.posix.dirname(SITE + "/" + long), { recursive: true });
  fs.writeFileSync(SITE + "/" + long, "<p>deep</p>");
  const packed = await publish.packSite(fs, path.posix, SITE);
  assert.equal(packed.files, 9);
  const bytes = new Uint8Array(packed.body);
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x8b);

  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "publish-test-"));
  try {
    const archive = path.join(dir, "site.tar.gz");
    nodeFs.writeFileSync(archive, bytes);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    const names = listing.stdout.trim().split("\n");
    assert.ok(
      names.every((name) => name.startsWith("./")),
      names.join(","),
    );
    assert.ok(names.includes("./" + long));
    const out = path.join(dir, "out");
    nodeFs.mkdirSync(out);
    const extract = spawnSync("tar", ["-xzf", archive, "-C", out], {
      encoding: "utf8",
    });
    assert.equal(extract.status, 0, extract.stderr);
    assert.equal(
      nodeFs.readFileSync(path.join(out, "index.html"), "utf8"),
      "<p>static index</p>",
    );
    assert.equal(
      nodeFs.readFileSync(path.join(out, long), "utf8"),
      "<p>deep</p>",
    );
    assert.equal(nodeFs.existsSync(path.join(out, "build")), false);
    assert.equal(nodeFs.existsSync(path.join(out, ".htaccess")), false);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a site with no index.html is not packed", async () => {
  const fs = createFsFromVolume(new Volume());
  fs.mkdirSync(SITE, { recursive: true });
  fs.writeFileSync(SITE + "/site.json", "{}");
  await assert.rejects(
    publish.packSite(fs, path.posix, SITE),
    /no index\.html/,
  );
});

test("listSites lists site folders with their title and CNAME domain", () => {
  const fs = seed();
  fs.mkdirSync(SITES + "/not-a-site", { recursive: true });
  fs.mkdirSync(SITES + "/two", { recursive: true });
  fs.writeFileSync(SITES + "/two/site.json", "not json");
  fs.writeFileSync(SITES + "/stray.txt", "x");
  assert.deepEqual(publish.listSites(fs, path.posix, SITES), [
    { name: "one", title: "Site One", domain: "one-abc123.surge.sh" },
    { name: "two", title: "two", domain: "" },
  ]);
});

test("site names are folder names, never paths", () => {
  for (const name of ["one", "my-site", "site_2", "a.b"]) {
    assert.equal(publish.validSiteName(name), true, name);
  }
  for (const name of ["", "..", "../x", "a/b", ".hidden", "a..b", null, 3]) {
    assert.equal(publish.validSiteName(name), false, String(name));
  }
});
