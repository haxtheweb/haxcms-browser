// The same site served at the root of a domain (Vercel, a custom domain)
// instead of under /haxcms-browser/: start, make a site, open it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startPagesServer } from "./helpers/pages-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "root-site";

let out;
let server;
let browser;
let host;
let frame;
let mount;

before(async () => {
  if (!fs.existsSync(path.join(root, "dist", "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  out = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-root-"));
  const assembled = spawnSync(
    process.execPath,
    ["scripts/build-site.mjs", "--out", out, "--link"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(assembled.status, 0, assembled.stderr);
  server = await startPagesServer(out, "");
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
  frame = host.frames().find((f) => f.url().includes("/app/"));
  mount = frame ? new URL(frame.url()).pathname : null;
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

test("at the root of a domain HAXcms starts and shows the dashboard", async () => {
  assert.equal(
    await host.$eval("#dot", (dot) => dot.dataset.state),
    "ready",
    await host.$eval("#status", (status) => status.textContent),
  );
  assert.match(mount, /^\/app\/[0-9a-f]{16}\/$/);
  await frame.waitForFunction(
    () => globalThis.appSettings && globalThis.appSettings.jwt,
    { timeout: 30000 },
  );
});

test("at the root of a domain a site can be created and opened", async () => {
  const created = await frame.evaluate(async (name) => {
    const s = globalThis.appSettings;
    const response = await fetch("system/api/v1/sites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + s.jwt,
        "x-haxcms-user-token": s.userToken,
      },
      body: JSON.stringify({
        site: { name },
        build: { type: "own", structure: "course", items: null, files: null },
        theme: { name: "clean-one", variables: {} },
      }),
    });
    return response.status;
  }, SITE);
  assert.equal(created, 200);

  const sitePage = await browser.newPage();
  await sitePage.goto(
    new URL(mount + "_sites/" + SITE + "/", server.url).href,
    { waitUntil: "load" },
  );
  assert.ok(await sitePage.$("header.bar"), "status bar on the site's tab");
  const siteFrame = sitePage.frames().find((f) => f !== sitePage.mainFrame());
  assert.ok(siteFrame, "the site is shown inside the wrapper");
  await siteFrame.waitForFunction(
    () =>
      globalThis.appSettings &&
      globalThis.appSettings.jwt &&
      document.querySelector("haxcms-site-builder"),
    { timeout: 30000 },
  );
  assert.equal(
    await siteFrame.evaluate(
      () => globalThis.appSettings.appStore.params.siteName,
    ),
    SITE,
  );
});

test("at the root of a domain nothing HAXcms asks for reaches the web server", () => {
  assert.deepEqual(
    server.requests.filter((r) => /^\w+ \/app\//.test(r)),
    [],
  );
});
