// The installable app (haxtheweb/issues#3331): the web app manifest, the
// offline copy and its update notice, the two ways out (Remove offline copy
// and reset.html), and things shared to HAX from another app. The static
// site is served the way GitHub Pages serves a project site and driven in
// headless Chrome; "no connection" is the web server dropping every
// connection.
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
import { writeOfflineManifest } from "../scripts/offline-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "offline-site";
const SCOPE = "/haxcms-browser/";
const COPY = "haxcms-browser-offline:1:" + SCOPE + ":";

let out;
let server;
let browser;
let host;

// the HAXcms frame inside the host page, once HAXcms is running
async function ready(page) {
  await page.waitForFunction(
    () =>
      ["ready", "error"].includes(document.getElementById("dot").dataset.state),
    { timeout: 90000 },
  );
  assert.equal(
    await page.$eval("#status", (el) => el.textContent),
    "HAXcms is running in your browser",
    await page.$eval("#message", (el) => el.textContent),
  );
  const frame = page.frames().find((f) => f.url().includes("/app/"));
  await frame.waitForFunction(() => globalThis.appSettings, {
    timeout: 30000,
  });
  return frame;
}

// the offline copies in this browser: [{ name, meta, entries }]
function copies(page) {
  return page.evaluate(async (prefix) => {
    const found = [];
    for (const name of await caches.keys()) {
      if (name.indexOf(prefix) !== 0) {
        continue;
      }
      const cache = await caches.open(name);
      const meta = await cache.match(
        location.origin + "/haxcms-browser/__offline/meta.json",
      );
      found.push({
        name,
        meta: meta ? await meta.json() : null,
        entries: (await cache.keys()).length,
      });
    }
    return found;
  }, COPY);
}

function serverManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(out, "offline-manifest.json"), "utf8"),
  );
}

async function openDetails(page) {
  if (await page.$eval("#details", (el) => el.hidden)) {
    await page.click("#details-button");
  }
}

function toastText(page) {
  return page.$eval("#toast", (el) =>
    el.hidden ? "" : document.getElementById("toast-text").textContent,
  );
}

before(async () => {
  if (!fs.existsSync(path.join(root, "dist", "haxcms-worker.js"))) {
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    assert.equal(built.status, 0, "build failed");
  }
  out = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-offline-"));
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
  await ready(host);
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

test("the page can be installed: its manifest, icons and share target are in place", async () => {
  const manifest = await host.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const response = await fetch(link.href);
    const body = await response.json();
    const icons = [];
    for (const icon of body.icons) {
      const fetched = await fetch(new URL(icon.src, link.href));
      icons.push([
        icon.sizes,
        fetched.status,
        fetched.headers.get("content-type"),
      ]);
    }
    return {
      body,
      icons,
      // where the browser will take these to mean, under this site's path
      start: new URL(body.start_url, link.href).pathname,
      scope: new URL(body.scope, link.href).pathname,
      share: new URL(body.share_target.action, link.href).pathname,
    };
  });
  assert.equal(manifest.body.display, "standalone");
  assert.equal(manifest.start, SCOPE);
  assert.equal(manifest.scope, SCOPE);
  assert.equal(manifest.share, SCOPE + "share");
  assert.equal(manifest.body.share_target.method, "POST");
  assert.deepEqual(
    manifest.icons.map((icon) => icon.slice(1)),
    manifest.icons.map(() => [200, "image/png"]),
  );
  assert.ok(
    manifest.icons.some((icon) => icon[0] === "192x192") &&
      manifest.icons.some((icon) => icon[0] === "512x512"),
    "the two sizes browsers ask for before offering install",
  );
});

test("nothing is kept for offline use until someone asks", async () => {
  assert.deepEqual(await copies(host), []);
  await openDetails(host);
  assert.equal(await host.$eval("#offline-save", (el) => el.hidden), false);
  assert.equal(await host.$eval("#offline-remove", (el) => el.hidden), true);
  assert.equal(await toastText(host), "");
});

test("Make available offline saves one whole build", async () => {
  await openDetails(host);
  await host.click("#offline-save");
  await host.waitForFunction(
    () =>
      /works offline/.test(
        document.getElementById("offline-state").textContent,
      ),
    { timeout: 240000 },
  );
  const manifest = serverManifest();
  const english = JSON.parse(
    fs.readFileSync(path.join(out, "offline-locales", "en.json"), "utf8"),
  );
  const saved = await copies(host);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, COPY + manifest.build);
  assert.equal(saved[0].meta.build, manifest.build);
  assert.ok(saved[0].meta.languages.includes("en"));
  assert.ok(
    saved[0].meta.files >=
      Object.keys(manifest.files).length + Object.keys(english.files).length,
    "every listed file, and the translations for this browser's languages",
  );
  // the files, the list of them and the meta record
  assert.equal(saved[0].entries, saved[0].meta.files + 2);
  assert.match(await toastText(host), /ready to work offline/);
  await host.click("#toast-dismiss");
  // only the languages asked for: the rest stay on the web server
  const french = await host.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    return keys.filter((request) =>
      /\/locales\/[^/]+\.fr\.json$/.test(request.url),
    ).length;
  }, saved[0].name);
  assert.equal(french, 0);
});

test("with no connection HAX starts, and a site can be made, edited and kept", async () => {
  server.setDown(true);
  await host.reload({ waitUntil: "load" });
  let frame = await ready(host);
  await frame.waitForFunction(() => document.title === "HAX: Home", {
    timeout: 30000,
  });
  // every file of the host page is answered from the copy
  const hostFiles = Object.keys(serverManifest().files).filter(
    (file) => !file.startsWith("public/"),
  );
  const answered = await host.evaluate(
    (files) =>
      Promise.all(
        files.map((file) =>
          fetch("./" + file).then(
            (response) => response.status,
            () => 0,
          ),
        ),
      ),
    hostFiles,
  );
  assert.deepEqual(
    hostFiles.filter((file, index) => answered[index] !== 200),
    [],
    "listed in HOST_FILES in sw.js",
  );
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

  // open the site: its theme and the editor come from the copy
  const mount = new URL(frame.url()).pathname.replace(/_sites\/.*$/, "");
  await frame.evaluate(
    (address) => {
      location.assign(address);
    },
    mount + "_sites/" + SITE + "/",
  );
  await host.waitForFunction(
    (name) => {
      const inner = document.getElementById("app").contentWindow;
      return (
        inner.location.pathname.includes("/_sites/" + name + "/") &&
        inner.appSettings &&
        inner.appSettings.jwt &&
        inner.document.querySelector("haxcms-site-builder")
      );
    },
    { timeout: 60000 },
    SITE,
  );
  frame = host.frames().find((f) => f.url().includes("/_sites/" + SITE));
  // the theme rendered the page: the front end loaded without the server
  await frame.waitForFunction(
    () => {
      const builder = document.querySelector("haxcms-site-builder");
      return (
        builder &&
        builder.shadowRoot &&
        document.querySelector(
          "haxcms-site-builder > *, #haxcmsoutdatedfallback",
        ) &&
        globalThis.customElements.get("haxcms-site-builder")
      );
    },
    { timeout: 60000 },
  );
  const saved = await frame.evaluate(async (name) => {
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
        body:
          '<page-break title="' +
          item.title +
          '" item-id="' +
          item.id +
          '"></page-break><p>Written with no connection</p>',
      }),
    });
    const stored = await (
      await fetch(item.location, { cache: "no-store" })
    ).text();
    return { status: response.status, stored };
  }, SITE);
  assert.equal(saved.status, 200);
  assert.match(saved.stored, /Written with no connection/);

  // still no connection: a reload brings the site back from browser storage
  await host.reload({ waitUntil: "load" });
  frame = await ready(host);
  const kept = await frame.evaluate(async (name) => {
    const response = await fetch("_sites/" + name + "/site.json", {
      cache: "no-store",
    });
    return response.status;
  }, SITE);
  assert.equal(kept, 200, "the site made offline is still there");
  // no newer build can be seen without a connection: no notice
  assert.equal(await toastText(host), "");
  server.setDown(false);
});

test("a newer build on the web server is offered, not taken, and updating swaps the whole copy", async () => {
  const before = (await copies(host))[0];
  const css = path.join(out, "shell.css");
  const oldCss = fs.readFileSync(css, "utf8");
  fs.writeFileSync(css, oldCss + "\n/* a newer build */\n");
  const manifest = writeOfflineManifest(out);
  assert.notEqual(manifest.build, before.meta.build);

  await host.reload({ waitUntil: "load" });
  await ready(host);
  await host.waitForFunction(
    () =>
      !document.getElementById("toast").hidden &&
      /newer version of HAX is available/.test(
        document.getElementById("toast-text").textContent,
      ),
    { timeout: 30000 },
  );
  // until the person says so, the page keeps running the build it has
  const served = await host.evaluate(async () =>
    (await fetch("./shell.css")).text(),
  );
  assert.equal(served, oldCss);
  assert.equal((await copies(host))[0].meta.build, before.meta.build);

  await host.click("#toast-action");
  await host.waitForFunction(
    () =>
      !document.getElementById("toast").hidden &&
      /Reload to start using it/.test(
        document.getElementById("toast-text").textContent,
      ),
    { timeout: 240000 },
  );
  const after = await copies(host);
  assert.equal(after.length, 1, "the old copy is gone");
  assert.equal(after[0].meta.build, manifest.build);
  assert.equal(after[0].entries, after[0].meta.files + 2);

  await host.click("#toast-action"); // Reload now
  await host.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  await ready(host);
  const now = await host.evaluate(async () =>
    (await fetch("./shell.css")).text(),
  );
  assert.match(now, /a newer build/);
  assert.equal(await toastText(host), "");
});

test("Remove offline copy goes back to loading from the web server", async () => {
  await openDetails(host);
  await host.click("#offline-remove");
  await host.waitForFunction(
    () =>
      /was removed/.test(document.getElementById("offline-state").textContent),
    { timeout: 30000 },
  );
  assert.deepEqual(await copies(host), []);
  // the service worker serves the web server's file again, at once
  const css = path.join(out, "shell.css");
  fs.writeFileSync(css, fs.readFileSync(css, "utf8") + "/* after removal */\n");
  const served = await host.evaluate(async () =>
    (await fetch("./shell.css", { cache: "reload" })).text(),
  );
  assert.match(served, /after removal/);
});

test("something shared to HAX waits until it is added, then becomes a page in the chosen site", async () => {
  // what the device's share sheet does: post a form to the share address
  await Promise.all([
    host.waitForNavigation({ waitUntil: "load" }),
    host.evaluate(() => {
      const form = document.createElement("form");
      form.method = "post";
      form.enctype = "multipart/form-data";
      form.action = "./share";
      const field = (name, value) => {
        const input = document.createElement("input");
        input.name = name;
        input.value = value;
        form.append(input);
      };
      field("title", "From my phone");
      field("text", "Look at <script>alert(1)</script> this & that");
      field("url", "https://haxtheweb.org/?a=1&b=2");
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        ),
        (c) => c.charCodeAt(0),
      );
      const files = document.createElement("input");
      files.type = "file";
      files.name = "files";
      files.multiple = true;
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([png], "Rink photo.png", { type: "image/png" }),
      );
      transfer.items.add(
        new File(["a,b\n1,2\n"], "roster.csv", { type: "text/csv" }),
      );
      files.files = transfer.files;
      form.append(files);
      document.body.append(form);
      form.submit();
    }),
  ]);
  assert.equal(new URL(host.url()).pathname, SCOPE);
  let frame = await ready(host);
  await host.waitForFunction(() => document.getElementById("share").open, {
    timeout: 30000,
  });
  assert.equal(new URL(host.url()).search, "", "the address is clean again");
  const shown = await host.evaluate(() => ({
    items: Array.from(
      document.querySelectorAll("#share-items li"),
      (li) => li.textContent,
    ),
    sites: Array.from(
      document.getElementById("share-site").options,
      (o) => o.value,
    ),
    title: document.getElementById("share-page").value,
    descriptions: document.querySelectorAll("#share-descriptions input").length,
  }));
  assert.deepEqual(shown.items, [
    "From my phone",
    "Look at <script>alert(1)</script> this & that",
    "https://haxtheweb.org/?a=1&b=2",
    "Rink photo.png",
    "roster.csv",
  ]);
  assert.ok(shown.sites.includes(SITE));
  assert.equal(shown.title, "From my phone");
  assert.equal(shown.descriptions, 1, "one description, for the image");

  // nothing has been added yet
  const itemsBefore = await frame.evaluate(
    async (name) =>
      (
        await (
          await fetch("_sites/" + name + "/site.json", { cache: "no-store" })
        ).json()
      ).items.length,
    SITE,
  );

  // Not now keeps it: it is offered again from the bar
  await host.click("#share-later");
  assert.equal(await host.$eval("#share-button", (el) => el.hidden), false);
  await host.click("#share-button");
  await host.waitForFunction(() => document.getElementById("share").open);

  await host.select("#share-site", SITE);
  await host.type("#share-descriptions input", "The rink at night");
  await host.click("#share-submit");
  await host.waitForFunction(() => !document.getElementById("share").open, {
    timeout: 60000,
  });
  assert.equal(await host.$eval("#share-button", (el) => el.hidden), true);

  await host.waitForFunction(
    (name) =>
      document
        .getElementById("app")
        .contentWindow.location.pathname.includes("/_sites/" + name + "/"),
    { timeout: 30000 },
    SITE,
  );
  frame = host.frames().find((f) => f.url().includes("/_sites/" + SITE));
  const result = await frame.evaluate(async () => {
    const manifest = await (
      await fetch("site.json", { cache: "no-store" })
    ).json();
    const item = manifest.items.find(
      (entry) => entry.title === "From my phone",
    );
    return {
      count: manifest.items.length,
      found: !!item,
      slug: item && item.slug,
      at: location.pathname,
      content: item
        ? await (await fetch(item.location, { cache: "no-store" })).text()
        : "",
      image: (await (await fetch("files/Rink-photo.png")).arrayBuffer())
        .byteLength,
      csv: await (await fetch("files/roster.csv")).text(),
    };
  });
  assert.equal(result.count, itemsBefore + 1);
  assert.ok(result.found, "the new page is in the site's outline");
  assert.ok(result.at.endsWith("/" + result.slug), "and it is the page shown");
  // text is text: escaped by this page, then sanitized by HAXcms
  assert.doesNotMatch(result.content, /<script/);
  assert.match(result.content, /this &amp; that/);
  assert.match(
    result.content,
    /<a href="https:\/\/haxtheweb\.org\/\?a=1&amp;b=2"/,
  );
  assert.match(
    result.content,
    /<img src="files\/Rink-photo\.png" alt="The rink at night"/,
  );
  assert.match(result.content, /<a href="files\/roster\.csv"/);
  assert.equal(result.image, 70);
  assert.equal(result.csv, "a,b\n1,2\n");
  // nothing of it is left waiting in the browser
  const left = await host.evaluate(async () => {
    const cache = await caches.open("haxcms-browser-share:/haxcms-browser/");
    return (await cache.keys()).length;
  });
  assert.equal(left, 0);
});

test("a share can be discarded without touching any site", async () => {
  await Promise.all([
    host.waitForNavigation({ waitUntil: "load" }),
    host.evaluate(() => {
      const form = document.createElement("form");
      form.method = "post";
      form.enctype = "multipart/form-data";
      form.action = "./share";
      const input = document.createElement("input");
      input.name = "text";
      input.value = "https://example.com/only-a-link";
      form.append(input);
      document.body.append(form);
      form.submit();
    }),
  ]);
  const frame = await ready(host);
  await host.waitForFunction(() => document.getElementById("share").open, {
    timeout: 30000,
  });
  const count = () =>
    frame.evaluate(
      async (name) =>
        (
          await (
            await fetch("_sites/" + name + "/site.json", { cache: "no-store" })
          ).json()
        ).items.length,
      SITE,
    );
  const itemsBefore = await count();
  await host.click("#share-discard");
  await host.waitForFunction(() => !document.getElementById("share").open);
  assert.equal(await host.$eval("#share-button", (el) => el.hidden), true);
  assert.equal(await count(), itemsBefore);
});

test("reset.html removes the service worker and the offline copy, and leaves sites alone", async () => {
  // a copy to remove, and another site's on the same origin to leave
  await host.evaluate(async (prefix) => {
    const mine = await caches.open(prefix + "pretend");
    await mine.put(location.origin + "/haxcms-browser/x", new Response("x"));
    const theirs = await caches.open("haxcms-browser-offline:1:/elsewhere/:b");
    await theirs.put(location.origin + "/elsewhere/x", new Response("x"));
  }, COPY);
  const page = await browser.newPage();
  await page.goto(server.url + "reset.html", { waitUntil: "load" });
  // the page came from the web server, not through the service worker
  assert.ok(server.requests.includes("GET " + SCOPE + "reset.html"));
  await page.click("#reset");
  await page.waitForFunction(
    () => document.getElementById("result").dataset.done === "true",
    { timeout: 30000 },
  );
  const left = await page.evaluate(async () => ({
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    caches: await caches.keys(),
  }));
  assert.equal(left.workers, 0);
  assert.deepEqual(left.caches, ["haxcms-browser-offline:1:/elsewhere/:b"]);
  await page.close();

  // opening HAX again starts fresh from the web, with the sites still there
  await host.goto(server.url, { waitUntil: "load" });
  const frame = await ready(host);
  const kept = await frame.evaluate(async (name) => {
    const response = await fetch("_sites/" + name + "/site.json", {
      cache: "no-store",
    });
    return response.status;
  }, SITE);
  assert.equal(kept, 200);
});
