// Outbound requests from the browser runtime (haxtheweb/issues#3389):
// haxcms-nodejs's safeFetch reaches the web through the browser's fetch.
// Chrome maps a made-up public name to a local test server, so the page sees
// an ordinary web address while nothing leaves this machine.
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
const PUBLIC_NAME = "haxcms-outbound.test";

let host;
let remote;
let browser;
let page;
// paths the stand-in web site was asked for
const seen = [];

function send(type, args) {
  return page.evaluate(
    (type, args) => globalThis.haxcmsWorker(type, args),
    type,
    args || {},
  );
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
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
  // the page and the Worker
  host = http.createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>haxcms-browser outbound</title>");
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
  });
  const hostPort = await listen(host);
  // a stand-in web site, reached as http://haxcms-outbound.test:<port>
  remote = http.createServer((req, res) => {
    seen.push(req.url);
    const cors = () => res.setHeader("access-control-allow-origin", "*");
    const port = remote.address().port;
    if (req.url === "/doc.md") {
      cors();
      res.setHeader("content-type", "text/markdown");
      res.end("# Fetched from the web\n");
      return;
    }
    if (req.url === "/no-cors.md") {
      res.setHeader("content-type", "text/markdown");
      res.end("# Should not be readable\n");
      return;
    }
    if (req.url === "/moved.md") {
      cors();
      res.statusCode = 302;
      res.setHeader("location", "/doc.md");
      res.end();
      return;
    }
    if (req.url === "/to-local.md") {
      cors();
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1:" + port + "/doc.md");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await listen(remote);
  browser = await puppeteer.launch({
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--host-resolver-rules=MAP " + PUBLIC_NAME + " 127.0.0.1",
    ],
    timeout: 120000,
  });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${hostPort}/`);
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
  const snapshot = await page.evaluate(async () =>
    (await fetch("/haxcms-snapshot.json")).json(),
  );
  const booted = await send("boot", { snapshot, root: "/haxcms" });
  for (const name of ["dns", "https"]) {
    assert.ok(!booted.unavailable.includes(name), name + " is provided");
  }
});

after(async () => {
  if (browser) {
    await browser.close();
  }
  for (const server of [host, remote]) {
    if (server) {
      server.close();
    }
  }
});

// md-to-html with type "link" fetches the markdown through safeFetch and
// answers "" when the fetch is refused or fails
async function markdownFrom(url) {
  const res = await send("request", {
    method: "POST",
    url: "/system/api/v1/actions/md-to-html",
    headers: {
      "content-type": "application/json",
      "x-haxcms-user-token": "local",
    },
    body: Buffer.from(JSON.stringify({ md: url, type: "link" })).toString(
      "base64",
    ),
  });
  assert.equal(res.status, 200);
  return JSON.parse(Buffer.from(res.body, "base64").toString("utf8")).data
    .contents;
}

function remoteUrl(file) {
  return "http://" + PUBLIC_NAME + ":" + remote.address().port + file;
}

test("a site that allows browser requests is fetched", async () => {
  const html = await markdownFrom(remoteUrl("/doc.md"));
  assert.match(html, /<h1>Fetched from the web<\/h1>/);
});

test("a redirect to another public address is followed", async () => {
  const html = await markdownFrom(remoteUrl("/moved.md"));
  assert.match(html, /<h1>Fetched from the web<\/h1>/);
});

test("a site that does not allow browser requests is not read", async () => {
  const html = await markdownFrom(remoteUrl("/no-cors.md"));
  assert.equal(html, "");
});

test("a redirect to this device is refused", async () => {
  // /doc.md allows every origin, so only the check on where the redirect
  // landed keeps its body from being read
  const html = await markdownFrom(remoteUrl("/to-local.md"));
  assert.equal(html, "");
});

test("names and addresses on this device or a local network are never requested", async () => {
  const port = remote.address().port;
  seen.length = 0;
  for (const url of [
    "http://localhost:" + port + "/doc.md",
    "http://127.0.0.1:" + port + "/doc.md",
    "http://[::1]:" + port + "/doc.md",
    "http://printer.local:" + port + "/doc.md",
    "http://router:" + port + "/doc.md",
    "http://192.168.1.1/doc.md",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    assert.equal(await markdownFrom(url), "", url);
  }
  assert.deepEqual(seen, [], "no request reached the test server");
});
