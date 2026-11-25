// Open in HAX (haxtheweb/issues#3405): a generator on another website opens
// this site with ?handoff=1 and hands it a HAXcms site zip, tab to tab. A
// stand-in generator page is served from a second origin and uses the real
// open-in-hax.js from the site, so this drives the whole contract: ready,
// offer, the consent dialog, payload, import through HAXcms, result.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startPagesServer } from "./helpers/pages-server.mjs";
import { zipStored } from "./helpers/site-zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let out;
let server;
let generatorServer;
let generatorUrl;
let browser;

const SITE_JSON = {
  title: "My 90s page",
  description: "Under construction",
  metadata: {
    site: { name: "my-90s-page" },
    // a theme only the site's own custom build has
    theme: {
      element: "custom-geocities-theme",
      path: "./custom/build/custom.es6.js",
    },
  },
  items: [
    {
      id: "item-home",
      title: "Welcome",
      slug: "welcome",
      location: "pages/home/index.html",
      parent: null,
      indent: 0,
      order: 0,
    },
  ],
};

function siteZip() {
  return zipStored({
    "my-90s-page/site.json": JSON.stringify(SITE_JSON),
    "my-90s-page/pages/home/index.html":
      "<p>Welcome to my homepage</p><script>alert(1)</script>",
    "my-90s-page/custom/build/custom.es6.js":
      "export const geocities = 'under construction';",
  });
}

// The generator page: an <open-in-hax> button, and a raw sender that keeps
// to the protocol but lies about the size, to check the receiver's limits.
function generatorPage(siteUrl) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture generator</title></head>
<body>
<open-in-hax site-title="My 90s page" generator="Fixture generator"></open-in-hax>
<script type="module">
  import { openInHax } from ${JSON.stringify(siteUrl + "open-in-hax.js")};
  globalThis.results = [];
  globalThis.openInHax = openInHax;
  document.addEventListener("open-in-hax-result", (e) => results.push(e.detail));
  // a site the test sets (base64), held back until release() when asked
  let release;
  globalThis.hold = () => new Promise((resolve) => (release = resolve));
  globalThis.release = () => release();
  globalThis.useSite = (base64, held) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    document.querySelector("open-in-hax").getSite = async () => {
      if (held) {
        await held;
      }
      return new Blob([bytes], { type: "application/zip" });
    };
  };
  // the protocol by hand: offer says offerSize, payload sends size bytes
  globalThis.rawHandoff = (offerSize, size) => {
    const target = new URL(${JSON.stringify(siteUrl + "?handoff=1")});
    const tab = open(target.href, "_blank");
    const msg = (type, fields) =>
      Object.assign({ protocol: "hax-handoff", version: 1, type }, fields);
    addEventListener("message", (event) => {
      if (event.source !== tab || event.origin !== target.origin) return;
      const data = event.data;
      if (data.type === "ready") {
        tab.postMessage(
          msg("offer", { generator: { name: "Raw" }, title: "Raw site", format: "haxcms-zip", size: offerSize }),
          target.origin,
        );
      } else if (data.type === "consent" && data.allowed) {
        tab.postMessage(msg("payload", { data: new Blob([new Uint8Array(size)]) }), target.origin);
      } else if (data.type === "result") {
        results.push({ ok: data.ok, name: data.name, error: data.error });
      }
    });
  };
</script>
</body></html>`;
}

before(async () => {
  if (!fs.existsSync(path.join(root, "dist", "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  out = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-handoff-"));
  const assembled = spawnSync(
    process.execPath,
    ["scripts/build-site.mjs", "--out", out, "--link"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(assembled.status, 0, assembled.stderr);
  server = await startPagesServer(out, "haxcms-browser");
  // the generator: another origin (another port)
  const page = generatorPage(server.url);
  generatorServer = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
  });
  await new Promise((resolve) =>
    generatorServer.listen(0, "127.0.0.1", resolve),
  );
  generatorUrl = "http://127.0.0.1:" + generatorServer.address().port + "/";
  assert.notEqual(new URL(generatorUrl).origin, new URL(server.url).origin);
  browser = await puppeteer.launch({
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
    timeout: 120000,
    defaultViewport: { width: 1280, height: 800 },
  });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
  if (server) {
    server.close();
  }
  if (generatorServer) {
    generatorServer.close();
  }
  if (out) {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// open the generator, start a handoff with start(page), and resolve the tab
// it opened
async function startHandoff(start) {
  const generator = await browser.newPage();
  await generator.goto(generatorUrl, { waitUntil: "load" });
  await generator.waitForFunction(() => !!globalThis.useSite);
  const opened = browser.waitForTarget(
    (target) => target.opener() === generator.target(),
    { timeout: 30000 },
  );
  await start(generator);
  const tab = await (await opened).page();
  return { generator, tab };
}

async function result(generator) {
  // the generator is a background tab, where animation frames do not run,
  // so this polls on a timer
  await generator.waitForFunction(() => globalThis.results.length > 0, {
    timeout: 120000,
    polling: 200,
  });
  return generator.evaluate(() => globalThis.results[0]);
}

function consentShown(tab) {
  return tab.waitForFunction(
    () => document.getElementById("handoff").open === true,
    { timeout: 30000 },
  );
}

test("a site sent from another website opens in HAX once the person allows it", async () => {
  const zip = siteZip().toString("base64");
  const { generator, tab } = await startHandoff(async (page) => {
    await page.evaluate((b64) => globalThis.useSite(b64), zip);
    await page.click("open-in-hax");
  });
  try {
    await consentShown(tab);
    const asked = await tab.evaluate(() => ({
      from: document.getElementById("handoff-from").textContent,
      site: document.getElementById("handoff-site").textContent,
      details: document.getElementById("handoff-details").textContent,
      // ?handoff is taken out of the address once read
      search: globalThis.location.search,
    }));
    // the browser's origin, not the sender's claim, names the sender
    assert.equal(asked.from, new URL(generatorUrl).host);
    assert.equal(asked.site, "My 90s page");
    assert.match(asked.details, /It says it comes from Fixture generator/);
    assert.equal(asked.search, "");
    await tab.click("#handoff-allow");
    const done = await result(generator);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.ok(done.name);
    // the site opens in the editor's frame
    await tab.waitForFunction(
      (name) => {
        const app = document.getElementById("app");
        return (
          app.contentWindow &&
          app.contentWindow.location.pathname.indexOf(
            "/_sites/" + encodeURIComponent(name) + "/",
          ) !== -1
        );
      },
      { timeout: 60000 },
      done.name,
    );
    const saved = await tab.evaluate(async (name) => {
      const app = document.getElementById("app").contentWindow;
      const base = new URL(
        "_sites/" + encodeURIComponent(name) + "/",
        app.location.href.split("/_sites/")[0] + "/",
      );
      const site = await (await app.fetch(new URL("site.json", base))).json();
      const page = await (
        await app.fetch(new URL(site.items[0].location, base))
      ).text();
      const custom = await (
        await app.fetch(new URL("custom/build/custom.es6.js", base))
      ).text();
      return {
        title: site.items[0].title,
        page,
        custom,
        theme: site.metadata.theme,
        siteTitle: site.title,
      };
    }, done.name);
    assert.equal(saved.title, "Welcome");
    assert.match(saved.page, /Welcome to my homepage/);
    // sanitized like any import
    assert.doesNotMatch(saved.page, /<script/);
    // the site's own code came with it (on in the browser)
    assert.match(saved.custom, /under construction/);
    // and its theme is the one selected, not the default
    assert.equal(saved.theme.element, "custom-geocities-theme");
    assert.equal(saved.theme.path, "./custom/build/custom.es6.js");
    // the site keeps its title, not its folder name
    assert.equal(saved.siteTitle, "My 90s page");
  } finally {
    await tab.close();
    await generator.close();
  }
});

test("only the opener can offer, and declining sends nothing and opens the start screen", async () => {
  const zip = siteZip().toString("base64");
  const { generator, tab } = await startHandoff(async (page) => {
    await page.evaluate(
      (b64) => globalThis.useSite(b64, globalThis.hold()),
      zip,
    );
    await page.click("open-in-hax");
  });
  try {
    await tab.waitForFunction(() => document.readyState === "complete");
    // an offer from a window that did not open this tab is ignored
    await tab.evaluate(() =>
      globalThis.postMessage(
        {
          protocol: "hax-handoff",
          version: 1,
          type: "offer",
          title: "Not from the opener",
          format: "haxcms-zip",
          size: 10,
        },
        "*",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await tab.evaluate(() => document.getElementById("handoff").open),
      false,
    );
    await generator.evaluate(() => globalThis.release());
    await consentShown(tab);
    await tab.click("#handoff-decline");
    assert.deepEqual(await result(generator), {
      ok: false,
      error: "declined",
    });
    assert.equal(
      await tab.evaluate(() => document.getElementById("handoff").open),
      false,
    );
  } finally {
    await tab.close();
    await generator.close();
  }
});

test("a payload bigger than its offer is refused", async () => {
  const { generator, tab } = await startHandoff((page) =>
    page.evaluate(() => globalThis.rawHandoff(10, 5000)),
  );
  try {
    await consentShown(tab);
    await tab.click("#handoff-allow");
    const done = await result(generator);
    assert.equal(done.ok, false);
    assert.equal(done.error, "too-large");
  } finally {
    await tab.close();
    await generator.close();
  }
});

test("something that is not a site zip is refused after it arrives", async () => {
  const notZip = Buffer.from("hello, not a zip").toString("base64");
  const { generator, tab } = await startHandoff(async (page) => {
    await page.evaluate((b64) => globalThis.useSite(b64), notZip);
    await page.click("open-in-hax");
  });
  try {
    await consentShown(tab);
    await tab.click("#handoff-allow");
    const done = await result(generator);
    assert.equal(done.ok, false);
    assert.equal(done.error, "not-a-zip");
  } finally {
    await tab.close();
    await generator.close();
  }
});
