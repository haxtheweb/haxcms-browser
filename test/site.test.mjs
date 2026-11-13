// The hosted demo, end to end: the static site (scripts/build-site.mjs) is
// served the way GitHub Pages serves a project site (under /haxcms-browser/)
// and driven in headless Chrome. Checks the pieces only the site adds on top
// of the Worker: the service worker relay, the session mount, sign-in, and
// the rules about what gets relayed.
//
// Needs `npm run build` (the test assembles the site itself, with the
// front-end build linked instead of copied).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startPagesServer } from "./helpers/pages-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "smoke-site";

let out;
let server;
let browser;
let host;
let frame;
let mount;
const escaped = [];

before(async () => {
  if (!fs.existsSync(path.join(root, "dist", "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  out = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-site-"));
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

test("the host page starts HAXcms and shows the dashboard, signed in", async () => {
  assert.equal(
    await host.$eval("#status", (el) => el.textContent),
    "HAXcms is running in your browser",
  );
  assert.ok(mount, "the HAXcms frame is mounted");
  assert.match(mount, /^\/haxcms-browser\/app\/[a-z0-9]{8}\/$/);
  await frame.waitForFunction(() => document.title === "HAX: Home", {
    timeout: 30000,
  });
  // signed in as the local user: no login needed
  const settings = await frame.evaluate(() => ({
    jwt: !!(globalThis.appSettings && globalThis.appSettings.jwt),
    userToken: !!(globalThis.appSettings && globalThis.appSettings.userToken),
  }));
  assert.deepEqual(settings, { jwt: true, userToken: true });
});

test("a site can be created, opened and saved to, all inside the browser", async () => {
  // the dashboard's own create-site call, made from the dashboard page
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

  // "Go to Site" opens the site in its own tab: it gets the status bar too
  const sitePage = await browser.newPage();
  sitePage.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === new URL(server.url).origin &&
      !url.pathname.startsWith("/haxcms-browser/")
    ) {
      escaped.push(url.pathname);
    }
  });
  await sitePage.goto(
    new URL(mount + "_sites/" + SITE + "/", server.url).href,
    {
      waitUntil: "load",
    },
  );
  assert.ok(
    await sitePage.$("header.bar"),
    "status bar on a page in its own tab",
  );
  const siteFrame = sitePage.frames().find((f) => f !== sitePage.mainFrame());
  assert.ok(siteFrame, "the site is shown inside the wrapper");
  await siteFrame.waitForFunction(
    () =>
      globalThis.appSettings &&
      globalThis.appSettings.jwt &&
      document.querySelector("haxcms-site-builder"),
    { timeout: 30000 },
  );
  const context = await siteFrame.evaluate(() => ({
    siteName: globalThis.appSettings.appStore.params.siteName,
    title: document.title,
  }));
  assert.equal(
    context.siteName,
    SITE,
    "HAXcms knows which site the page is in",
  );

  // save page content the way the editor does
  const saved = await siteFrame.evaluate(async (name) => {
    const s = globalThis.appSettings;
    const manifest = await (await fetch("site.json")).json();
    const item = manifest.items[0];
    const response = await fetch("../../x/api/v1/content/" + item.id, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + s.jwt,
        "x-haxcms-site-token": s.siteToken,
      },
      body: JSON.stringify({
        site: { name },
        // the editor sends the page as a <page-break> followed by its content
        body:
          '<page-break title="' +
          item.title +
          '" item-id="' +
          item.id +
          '"></page-break><p>Saved from the smoke test</p><script>alert("x")</script>',
      }),
    });
    const stored = await (
      await fetch(item.location, { cache: "no-store" })
    ).text();
    return {
      status: response.status,
      stored,
      answer: (await response.text()).slice(0, 300),
    };
  }, SITE);
  assert.equal(saved.status, 200, saved.answer);
  assert.match(saved.stored, /Saved from the smoke test/);
  // the content went through haxcms-nodejs's sanitizer on the way in
  assert.doesNotMatch(saved.stored, /<script/);
  await sitePage.close();
});

test("only pages inside a session can change it", async () => {
  // the host page is on this origin but not inside the mount
  const fromOutside = await host.evaluate(async (m) => {
    const response = await fetch(m + "system/api/v1/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: { name: "nope" } }),
    });
    return response.status;
  }, mount);
  assert.equal(fromOutside, 405);
});

test("a session that is not open says so instead of failing oddly", async () => {
  const page = await browser.newPage();
  await page.goto(new URL("/haxcms-browser/app/zzzzzzzz/", server.url).href, {
    waitUntil: "load",
  });
  const inner = page.frames().find((f) => f !== page.mainFrame());
  assert.ok(inner);
  await inner.waitForFunction(
    () => /not open/.test(document.body && document.body.innerText),
    { timeout: 15000 },
  );
  await page.close();
});

test("nothing HAXcms asks for reaches the web server", () => {
  // every HAXcms page and API request is answered in the browser; the static
  // server only ever sees the host page's files and the front-end build
  const relayed = server.requests.filter((r) =>
    /\/haxcms-browser\/app\//.test(r),
  );
  assert.deepEqual(relayed, []);
  assert.deepEqual(escaped, []);
});
