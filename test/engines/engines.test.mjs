// The hosted demo in real browser engines: WebKit (Safari and every iOS
// browser) and Firefox, run with Playwright's builds of them. `npm test`
// only drives headless Chrome, and a browser API that Chrome has and another
// engine lacks (a directory handle sent to a Worker, createWritable, the
// folder picker) only shows up in that engine.
//
// The journey every engine must manage: start HAXcms signed in, make a site,
// save it to the browser's own storage, and find it again after a reload.
//
//   npx playwright-core install webkit firefox   (once)
//   npm run test:engines
//
// HAXCMS_TEST_ENGINES picks the engines (default "webkit,firefox";
// "chromium" also works, with HAXCMS_TEST_CHROMIUM for a Chrome already on
// the machine). Needs `npm run build`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { startPagesServer } from "../helpers/pages-server.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENGINES = { chromium, firefox, webkit };
const wanted = (process.env.HAXCMS_TEST_ENGINES || "webkit,firefox")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const SITE = "engine-site";
const BROWSER_STORE = "haxcms-sites";

let out;
let server;

before(() => {
  if (!fs.existsSync(path.join(root, "dist", "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  out = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-engines-"));
  const assembled = spawnSync(
    process.execPath,
    ["scripts/build-site.mjs", "--out", out, "--link"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(assembled.status, 0, assembled.stderr);
});

after(() => {
  if (out) {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// Waits for the host page to finish starting. When it could not, the error
// the page shows (title and stack) is the failure message, so a CI log says
// what that engine tripped on.
async function waitStarted(page) {
  await page.waitForFunction(
    () =>
      ["ready", "error"].includes(document.getElementById("dot").dataset.state),
    null,
    { timeout: 120000 },
  );
  const state = await page.evaluate(() => ({
    dot: document.getElementById("dot").dataset.state,
    status: document.getElementById("status").textContent,
    message: document.getElementById("message").textContent,
  }));
  assert.equal(
    state.dot,
    "ready",
    state.status + ": " + state.message.slice(0, 1500),
  );
  assert.equal(state.status, "HAXcms is running in your browser");
  const frame = page.frames().find((f) => f.url().includes("/app/"));
  assert.ok(frame, "the HAXcms frame is mounted");
  await frame.waitForFunction(
    () => globalThis.appSettings && globalThis.appSettings.jwt,
    null,
    { timeout: 60000 },
  );
  return frame;
}

function listSites(frame) {
  return frame.evaluate(async () => {
    const s = globalThis.appSettings;
    const response = await fetch("system/api/v1/sites", {
      headers: {
        authorization: "Bearer " + s.jwt,
        "x-haxcms-user-token": s.userToken,
      },
    });
    const body = await response.json();
    return body.data.items.map((item) => item.metadata.site.name).sort();
  });
}

// every file below a folder in the browser's private file system
function listFolder(page, name) {
  return page.evaluate(async (folder) => {
    const top = await navigator.storage.getDirectory();
    const found = [];
    const walk = async (dir, prefix) => {
      for await (const [entryName, entry] of dir.entries()) {
        if (entry.kind === "directory") {
          await walk(entry, prefix + entryName + "/");
        } else {
          found.push(prefix + entryName);
        }
      }
    };
    await walk(await top.getDirectoryHandle(folder), "");
    return found.sort();
  }, name);
}

for (const name of wanted) {
  test(
    name + ": HAXcms starts, saves a site in the browser and keeps it",
    { timeout: 600000 },
    async () => {
      const engine = ENGINES[name];
      assert.ok(engine, "unknown engine " + name);
      // its own server (so its own origin and storage) and a profile kept on
      // disk, like a normal window: private windows restrict storage
      server = await startPagesServer(out, "haxcms-browser");
      const profile = fs.mkdtempSync(
        path.join(os.tmpdir(), "haxcms-browser-" + name + "-"),
      );
      const options = { headless: true, timeout: 120000 };
      if (name === "chromium") {
        options.executablePath =
          process.env.HAXCMS_TEST_CHROMIUM || "/usr/bin/google-chrome";
        options.args = ["--no-sandbox"];
      }
      let context;
      const problems = [];
      try {
        context = await engine.launchPersistentContext(profile, options);
        const page = context.pages()[0] || (await context.newPage());
        page.on("pageerror", (error) => problems.push(String(error)));
        page.on("console", (entry) => {
          if (
            entry.type() === "error" &&
            /error in API route|haxcms-browser/.test(entry.text())
          ) {
            problems.push(entry.text().slice(0, 600));
          }
        });
        await page.goto(server.url, { waitUntil: "load" });
        let frame = await waitStarted(page);

        // saving to the browser's own storage, not only to memory
        assert.match(
          await page.textContent("#note"),
          /^Saved in this browser/,
          "storage in use",
        );

        // the dashboard's own create-site call, made from the dashboard
        const created = await frame.evaluate(async (site) => {
          const s = globalThis.appSettings;
          const response = await fetch("system/api/v1/sites", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + s.jwt,
              "x-haxcms-user-token": s.userToken,
            },
            body: JSON.stringify({
              site: { name: site },
              build: {
                type: "own",
                structure: "course",
                items: null,
                files: null,
              },
              theme: { name: "clean-one", variables: {} },
            }),
          });
          return response.status;
        }, SITE);
        assert.equal(created, 200, "create site: " + problems.join("\n"));

        // written to the browser's storage as a HAXsite folder, with content
        const stored = await listFolder(page, BROWSER_STORE);
        assert.ok(
          stored.includes(SITE + "/site.json"),
          "site.json is stored: " + stored.slice(0, 5).join(", "),
        );
        assert.ok(stored.some((file) => file.startsWith(SITE + "/pages/")));
        const size = await page.evaluate(
          async ([folder, site]) => {
            const top = await navigator.storage.getDirectory();
            const sites = await top.getDirectoryHandle(folder);
            const dir = await sites.getDirectoryHandle(site);
            const file = await (await dir.getFileHandle("site.json")).getFile();
            return file.size;
          },
          [BROWSER_STORE, SITE],
        );
        assert.ok(size > 0, "site.json is not empty");

        // and still there, readable, after a reload
        await page.reload({ waitUntil: "load" });
        frame = await waitStarted(page);
        assert.deepEqual(await listSites(frame), [SITE]);
        const manifest = await frame.evaluate(async (site) => {
          const response = await fetch("_sites/" + site + "/site.json");
          return (await response.json()).items.length;
        }, SITE);
        assert.ok(manifest > 0, "the site's pages came back");
      } finally {
        if (context) {
          await context.close();
        }
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
      }
    },
  );
}
