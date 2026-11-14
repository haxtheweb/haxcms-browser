// The host page (the bar, the Details panel and its buttons) has no axe
// violations at WCAG 2.0 / 2.1 A and AA, in light and in dark, with the
// panel closed and open. The dashboard and editor inside the frame are
// tested where they are built (haxtheweb/webcomponents), so the frame's
// document is left out.
//
// Needs `npm run build` (the test assembles the site itself, with the
// front-end build linked instead of copied).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startPagesServer } from "./helpers/pages-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const axeSource = fs.readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

let out;
let server;
let browser;
let host;

async function violations(page) {
  const found = await page.evaluate(async () => {
    const results = await globalThis.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
      iframes: false,
    });
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.target.join(" ")),
    }));
  });
  return found;
}

before(async () => {
  if (!fs.existsSync(path.join(root, "dist", "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  out = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-a11y-"));
  const assembled = spawnSync(
    process.execPath,
    ["scripts/build-site.mjs", "--out", out, "--link"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(assembled.status, 0, assembled.stderr);
  server = await startPagesServer(out, "haxcms-browser");
  browser = await puppeteer.launch({
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
    timeout: 120000,
    defaultViewport: { width: 1280, height: 800 },
  });
  host = await browser.newPage();
  await host.goto(server.url, { waitUntil: "load" });
  await host.waitForFunction(
    () =>
      ["ready", "error"].includes(document.getElementById("dot").dataset.state),
    { timeout: 90000 },
  );
  await host.evaluate(axeSource);
});

after(async () => {
  if (browser) {
    await browser.close();
  }
  if (server) {
    server.close();
  }
  if (out) {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

for (const scheme of ["light", "dark"]) {
  test(`the host page has no axe violations (${scheme})`, async () => {
    await host.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: scheme },
    ]);
    assert.equal(
      await host.$eval("#status", (el) => el.textContent),
      "HAXcms is running in your browser",
    );
    assert.deepEqual(await violations(host), [], "Details panel closed");
    const toggle = await host.$('[aria-controls][aria-expanded="false"]');
    assert.ok(toggle, "the Details button");
    await toggle.click();
    await host.waitForSelector('[aria-controls][aria-expanded="true"]');
    assert.deepEqual(await violations(host), [], "Details panel open");
    await host.click('[aria-controls][aria-expanded="true"]');
    await host.waitForSelector('[aria-controls][aria-expanded="false"]');
  });
}
