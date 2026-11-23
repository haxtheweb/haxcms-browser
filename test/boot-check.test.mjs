// scripts/boot-check.mjs is what stops a Worker that cannot start from being
// deployed (haxtheweb/issues#3395). It must pass on a good build and fail,
// with the Worker's error, on one that cannot start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const script = path.join(root, "scripts/boot-check.mjs");

function check(folder) {
  return spawnSync(process.execPath, [script, folder], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
  });
}

test("passes on the built Worker", () => {
  if (!fs.existsSync(path.join(dist, "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  const result = check(dist);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Boot check passed/);
});

test("fails when the Worker cannot start", () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "boot-check-"));
  try {
    fs.copyFileSync(
      path.join(dist, "haxcms-snapshot.json"),
      path.join(broken, "haxcms-snapshot.json"),
    );
    // the same failure as the 2026-11-23 outage: boot throws while loading
    fs.writeFileSync(
      path.join(broken, "haxcms-worker.js"),
      `globalThis.onmessage = (event) => {
        globalThis.postMessage({ id: event.data.id, ok: false,
          error: 'TypeError: The "original" argument must be of type Function' });
      };`,
    );
    const result = check(broken);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Boot check FAILED/);
    assert.match(result.stderr, /"original" argument/);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test("fails when the build is missing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "boot-check-"));
  try {
    const result = check(empty);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
