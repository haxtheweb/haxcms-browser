// Parity: haxcms-nodejs in the browser Worker must behave exactly like
// haxcms-nodejs on Node. Builds dist/ first if needed, runs the shared
// scenario in headless Chrome and on Node, and compares the results.
//
// Chrome: PUPPETEER_EXECUTABLE_PATH, or /usr/bin/google-chrome.
// haxcms-nodejs: HAXCMS_NODEJS_SRC (e.g. a main checkout), or the installed
// package's dist/ (the same input scripts/build.mjs uses).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const src = process.env.HAXCMS_NODEJS_SRC
  ? path.resolve(process.env.HAXCMS_NODEJS_SRC)
  : path.join(
      path.dirname(require.resolve("@haxtheweb/haxcms-nodejs/package.json")),
      "dist",
    );
const { runScenario } = require("./scenario.cjs");

let server;
let browser;
let page;

function send(type, args) {
  return page.evaluate(
    (type, args) => globalThis.haxcmsWorker(type, args),
    type,
    args || {},
  );
}

before(async () => {
  if (!fs.existsSync(path.join(dist, "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  server = http
    .createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        res.end("<!doctype html><title>haxcms-browser parity</title>");
        return;
      }
      const file = path.join(dist, path.basename(req.url));
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader(
        "content-type",
        file.endsWith(".js") ? "text/javascript" : "application/json",
      );
      fs.createReadStream(file).pipe(res);
    })
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  browser = await puppeteer.launch({
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
    // a busy CI runner can take a while to start Chrome
    timeout: 120000,
  });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    const worker = new Worker("/haxcms-worker.js");
    const pending = new Map();
    let next = 0;
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id);
      pending.delete(id);
      if (ok) {
        p.resolve(result);
      } else {
        p.reject(new Error(error));
      }
    };
    globalThis.haxcmsWorker = (type, args) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        worker.postMessage(Object.assign({ id, type }, args));
      });
  });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
  if (server) {
    server.close();
  }
});

test("boots haxcms-nodejs in a Worker and reports what is unavailable", async () => {
  const snapshot = await page.evaluate(async () =>
    (await fetch("/haxcms-snapshot.json")).json(),
  );
  const booted = await send("boot", { snapshot, root: "/haxcms" });
  assert.equal(booted.mode, "multisite");
  assert.ok(Array.isArray(booted.unavailable));
  // the runtime must say which server-only pieces it replaced
  for (const name of ["child_process", "git-interface"]) {
    assert.ok(booted.unavailable.includes(name), name + " should be listed");
  }
});

test("HTTP API: browser and Node give the same results", async () => {
  const browserResult = await runScenario({
    async request(method, url, options) {
      const opts = options || {};
      const headers = Object.assign({}, opts.headers || {});
      let body = null;
      if (opts.json) {
        headers["content-type"] = "application/json";
        body = Buffer.from(JSON.stringify(opts.json)).toString("base64");
      }
      const res = await send("request", { method, url, headers, body });
      return {
        status: res.status,
        headers: res.headers,
        text: Buffer.from(res.body, "base64").toString("utf8"),
      };
    },
  });
  const hash = await send("hashPassword", { password: "parity-check" });
  const node = spawnSync(
    process.execPath,
    [
      path.join(root, "test/node-runner.cjs"),
      src,
      Buffer.from(hash).toString("base64") + ":parity-check",
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  const line = (node.stdout || "")
    .split("\n")
    .find((l) => l.startsWith("RESULT "));
  assert.ok(line, "node runner failed:\n" + node.stdout + node.stderr);
  const nodeResult = JSON.parse(line.slice("RESULT ".length));

  assert.deepEqual(browserResult.steps, nodeResult.steps);
  assert.deepEqual(browserResult.outline, nodeResult.outline);
  assert.deepEqual(browserResult.llmsHeadings, nodeResult.llmsHeadings);
  // the scenario has to have worked, not just failed the same way twice
  const status = (name) =>
    browserResult.steps.find((s) => s.step === name).status;
  assert.equal(status("create site"), 200);
  assert.equal(status("seed A, B"), 200);
  assert.ok(status("outline without a site token (refused)") >= 400);
  // failed saves must not write, in either runtime
  for (const step of browserResult.steps.filter(
    (s) => s.status >= 400 && "siteJsonUnchanged" in s,
  )) {
    assert.equal(step.siteJsonUnchanged, true, step.step);
  }
  // the new site's starter page stays; outline saves don't delete it
  assert.deepEqual(browserResult.outline, [
    "A < (root) #1",
    "B < (root) #0",
    "C < A #0",
    "Welcome < (root) #0",
  ]);
  // a password hash made in the browser verifies on a Node server
  assert.equal(nodeResult.verifiesBrowserHash, true);
});
