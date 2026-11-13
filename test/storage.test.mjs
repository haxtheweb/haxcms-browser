// DirectoryStorage: the sites folder in the in-memory volume and a directory
// handle (a folder on the user's computer, or the browser's private file
// system) are kept the same. Runs on Node with memfs and a stand-in handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { Volume, createFsFromVolume } from "memfs";
import { FakeDirectoryHandle } from "./helpers/fake-directory-handle.mjs";

const require = createRequire(import.meta.url);
const { DirectoryStorage } = require("../src/runtime/storage.cjs");

const ROOT = "/haxcms/_sites";

function setup(handle = new FakeDirectoryHandle()) {
  const fs = createFsFromVolume(new Volume());
  fs.mkdirSync(ROOT, { recursive: true });
  const storage = new DirectoryStorage({
    fs,
    path: path.posix,
    handle,
    root: ROOT,
  });
  return { fs, handle, storage };
}

function seedSite(fs) {
  fs.mkdirSync(ROOT + "/one/pages/a", { recursive: true });
  fs.mkdirSync(ROOT + "/one/files", { recursive: true });
  fs.writeFileSync(ROOT + "/one/site.json", '{"title":"One"}');
  fs.writeFileSync(ROOT + "/one/pages/a/index.html", "<p>a</p>");
}

test("flush writes what is new, and nothing the second time", async () => {
  const { fs, handle, storage } = setup();
  seedSite(fs);
  assert.deepEqual(await storage.flush(), { written: 2, removed: 0 });
  assert.deepEqual(handle.tree(), {
    "one/": null,
    "one/pages/": null,
    "one/pages/a/": null,
    "one/pages/a/index.html": "<p>a</p>",
    "one/files/": null,
    "one/site.json": '{"title":"One"}',
  });
  assert.deepEqual(await storage.flush(), { written: 0, removed: 0 });
});

test("changes, deletions and removed folders reach the handle", async () => {
  const { fs, handle, storage } = setup();
  seedSite(fs);
  await storage.flush();
  fs.writeFileSync(ROOT + "/one/site.json", '{"title":"One, edited"}');
  fs.rmSync(ROOT + "/one/pages", { recursive: true });
  assert.deepEqual(await storage.flush(), { written: 1, removed: 1 });
  assert.deepEqual(handle.tree(), {
    "one/": null,
    "one/files/": null,
    "one/site.json": '{"title":"One, edited"}',
  });
});

test("symbolic links and tool folders are not mirrored", async () => {
  const { fs, handle, storage } = setup();
  seedSite(fs);
  fs.mkdirSync("/haxcms/build");
  fs.symlinkSync("../../build", ROOT + "/one/build");
  fs.mkdirSync(ROOT + "/one/.git");
  fs.writeFileSync(ROOT + "/one/.git/HEAD", "ref");
  await storage.flush();
  const names = Object.keys(handle.tree());
  assert.ok(!names.some((name) => /build|\.git/.test(name)), names.join(", "));
});

test("a failed write throws, keeps the old file, and is retried", async () => {
  const { fs, handle, storage } = setup();
  seedSite(fs);
  await storage.flush();
  fs.writeFileSync(ROOT + "/one/site.json", '{"title":"Changed"}');
  fs.writeFileSync(ROOT + "/one/pages/a/index.html", "<p>changed</p>");

  handle.failWrites.add("site.json");
  await assert.rejects(
    storage.flush(),
    /could not save 1 file\(s\), first: one\/site\.json/,
  );
  // the file that failed is untouched; the one that could be written was
  assert.equal(handle.tree()["one/site.json"], '{"title":"One"}');
  assert.equal(handle.tree()["one/pages/a/index.html"], "<p>changed</p>");

  // a write that fails at the last step leaves the old file too
  handle.failWrites.clear();
  handle.failCloses.add("site.json");
  await assert.rejects(storage.flush(), /could not save/);
  assert.equal(handle.tree()["one/site.json"], '{"title":"One"}');

  // once the folder accepts writes again, the pending change goes through
  handle.failCloses.clear();
  assert.deepEqual(await storage.flush(), { written: 1, removed: 0 });
  assert.equal(handle.tree()["one/site.json"], '{"title":"Changed"}');
});

test("load brings a folder into a fresh volume, with nothing left to save", async () => {
  const first = setup();
  seedSite(first.fs);
  await first.storage.flush();

  const second = setup(first.handle);
  const loaded = await second.storage.load();
  assert.equal(loaded.files, 2);
  assert.equal(
    second.fs.readFileSync(ROOT + "/one/pages/a/index.html", "utf8"),
    "<p>a</p>",
  );
  assert.ok(second.fs.statSync(ROOT + "/one/files").isDirectory());
  first.handle.writes.length = 0;
  assert.deepEqual(await second.storage.flush(), { written: 0, removed: 0 });
  assert.deepEqual(first.handle.writes, []);
});

test("refresh picks up what another program changed in the folder", async () => {
  const { fs, handle, storage } = setup();
  seedSite(fs);
  await storage.flush();
  const one = await handle.getDirectoryHandle("one");
  (await one.getFileHandle("site.json")).externalWrite(
    '{"title":"From outside"}',
  );
  (await one.getFileHandle("notes.txt", { create: true })).externalWrite("new");
  await (
    await (await one.getDirectoryHandle("pages")).getDirectoryHandle("a")
  ).removeEntry("index.html");

  assert.deepEqual(await storage.refresh(), { updated: 2, removed: 1 });
  assert.equal(
    fs.readFileSync(ROOT + "/one/site.json", "utf8"),
    '{"title":"From outside"}',
  );
  assert.equal(fs.readFileSync(ROOT + "/one/notes.txt", "utf8"), "new");
  assert.equal(fs.existsSync(ROOT + "/one/pages/a/index.html"), false);
  // and none of that counts as something to write back
  handle.writes.length = 0;
  assert.deepEqual(await storage.flush(), { written: 0, removed: 0 });
  assert.deepEqual(handle.writes, []);
});
