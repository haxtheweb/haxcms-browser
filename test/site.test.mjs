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
import http from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startPagesServer } from "./helpers/pages-server.mjs";
import { redirectSurge } from "./helpers/surge-stand-in.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "smoke-site";

let out;
let server;
let browser;
let host;
let frame;
let mount;
const escaped = [];
const runtimeErrors = [];

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
    // a busy CI runner can take a while to start Chrome
    timeout: 120000,
    defaultViewport: { width: 1280, height: 800 },
  });
  host = await browser.newPage();
  // errors the runtime logs while answering a request, for failure messages
  host.on("console", (entry) => {
    if (
      entry.type() === "error" &&
      /error in API route|haxcms-browser/.test(entry.text())
    ) {
      runtimeErrors.push(entry.text().slice(0, 600));
    }
  });
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
  assert.match(mount, /^\/haxcms-browser\/app\/[0-9a-f]{16}\/$/);
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

  // Uploading a file: the editor posts to an absolute address the backend
  // gives it ("Local files" in the app store). That address has to be this
  // page's own origin, under the mount, or the browser cannot reach it.
  const upload = await siteFrame.evaluate(async () => {
    const s = globalThis.appSettings;
    const query = new URLSearchParams(s.appStore.params).toString();
    const store = await (
      await fetch(s.appStore.url + "?" + query, { headers: s.appStore.headers })
    ).json();
    const apps = (store.data || store).apps || [];
    const local = apps.find(
      (app) => app.details && app.details.title === "Local files",
    );
    if (!local) {
      return {
        error: "no Local files app",
        titles: apps.map((a) => a.details && a.details.title),
      };
    }
    const connection = local.connection;
    const add = connection.operations.add;
    const address = connection.protocol + "://" + connection.url + add.endPoint;
    const form = new FormData();
    // a 1x1 transparent PNG
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    form.append(
      "file-upload",
      new Blob([png], { type: "image/png" }),
      "dot.png",
    );
    const headers = Object.assign(
      { authorization: "Bearer " + s.jwt },
      connection.headers,
    );
    const response = await fetch(address, {
      method: add.method || "POST",
      headers,
      body: form,
    });
    const text = await response.text();
    const listed = await (await fetch("files/dot.png")).arrayBuffer();
    return {
      address,
      origin: new URL(address).origin,
      status: response.status,
      text: text.slice(0, 300),
      storedBytes: listed.byteLength,
      sent: png.length,
    };
  });
  assert.equal(upload.error, undefined, JSON.stringify(upload));
  assert.equal(upload.origin, new URL(server.url).origin, upload.address);
  assert.ok(
    upload.address.includes(mount + "_sites/" + SITE + "/"),
    upload.address,
  );
  assert.equal(
    upload.status,
    200,
    upload.text + "\n" + runtimeErrors.join("\n"),
  );
  assert.equal(
    upload.storedBytes,
    upload.sent,
    "the uploaded file is served back whole",
  );
  // left open on purpose: the host page is reloaded later with this tab
  // still showing the site, as someone working in two tabs would
});

test("clicking a site on the dashboard opens it", async () => {
  // the dashboard's router handles the click: it only knows the site if it
  // was told the path HAXcms is mounted under
  const page = await browser.newPage();
  await page.goto(new URL(mount, server.url).href, { waitUntil: "load" });
  const dashboard = page.frames().find((f) => f !== page.mainFrame());
  assert.ok(dashboard, "the dashboard is shown inside the wrapper");
  await dashboard.waitForFunction(
    () => {
      const app = document.querySelector("app-hax");
      const sites =
        app && app.store && app.store.manifest && app.store.manifest.items;
      return sites && sites.length > 0 && app.store.routes.length > 0;
    },
    { timeout: 60000 },
  );
  const state = await dashboard.evaluate((site) => {
    const app = document.querySelector("app-hax");
    const item = app.store.manifest.items.find((i) =>
      i.slug.endsWith("/" + site + "/"),
    );
    const link = document.createElement("a");
    link.href = item.slug;
    link.textContent = site;
    document.body.appendChild(link);
    link.click();
    return { basePath: app.basePath, slug: item.slug };
  }, SITE);
  assert.equal(state.basePath, mount, "the dashboard knows its mount path");
  const opened = await page
    .waitForFunction(
      (site) => {
        const inner = document.querySelector("iframe");
        try {
          const doc = inner.contentDocument;
          return (
            doc.location.pathname.endsWith("/_sites/" + site + "/") &&
            !!doc.querySelector("haxcms-site-builder")
          );
        } catch (e) {
          return false;
        }
      },
      { timeout: 30000 },
      SITE,
    )
    .then(
      () => true,
      () => false,
    );
  const where = await page.evaluate(() => {
    const inner = document.querySelector("iframe");
    const app = inner.contentDocument.querySelector("app-hax");
    return (
      inner.contentDocument.location.pathname + " mode=" + (app && app.appMode)
    );
  });
  await page.close();
  assert.equal(opened, true, "after the click: " + where);
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

// ---- where sites are saved ---------------------------------------------

async function waitReady(page) {
  // waits poll on animation frames, which a background tab does not get
  await page.bringToFront();
  try {
    await page.waitForFunction(
      () =>
        ["ready", "error"].includes(
          document.getElementById("dot").dataset.state,
        ),
      { timeout: 60000 },
    );
    const frame = page.frames().find((f) => f.url().includes("/app/"));
    await frame.waitForFunction(
      () => globalThis.appSettings && globalThis.appSettings.jwt,
      { timeout: 30000 },
    );
    return frame;
  } catch (error) {
    // say what the page was showing, not just that the wait ran out
    const seen = await page
      .evaluate(() => ({
        status: document.getElementById("status").textContent,
        note: document.getElementById("note").textContent,
        message: document.getElementById("message").textContent.slice(0, 400),
        frame: document.getElementById("app").getAttribute("src"),
      }))
      .catch((e) => ({ unreadable: String(e) }));
    const frames = page.frames().map((f) => f.url());
    throw new Error(
      error.message +
        "\n" +
        JSON.stringify({ seen, frames }, null, 1) +
        "\n" +
        runtimeErrors.slice(-5).join("\n"),
    );
  }
}

// the site names the dashboard would list
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
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const out = [];
    const walk = async (dir, prefix) => {
      for await (const [entryName, entry] of dir.entries()) {
        const relative = prefix + entryName;
        if (entry.kind === "directory") {
          await walk(entry, relative + "/");
        } else {
          out.push(relative);
        }
      }
    };
    await walk(await root.getDirectoryHandle(name), "");
    return out.sort();
  }, name);
}

test("sites are saved in the browser and are still there after a reload", async () => {
  assert.match(
    await host.$eval("#note", (el) => el.textContent),
    /^Saved in this browser/,
  );
  // the site made earlier went to the browser's storage, as a HAXsite folder
  const stored = await listFolder(host, "haxcms-sites");
  assert.ok(
    stored.includes(SITE + "/site.json"),
    stored.slice(0, 5).join(", "),
  );
  assert.ok(stored.some((file) => file.startsWith(SITE + "/pages/")));
  // the links haxcms-nodejs puts in a site to its shared front-end build
  // only make sense inside the runtime, and are not written out
  assert.deepEqual(
    stored.filter((file) => /^[^/]+\/(build|dist|node_modules)\//.test(file)),
    [],
  );

  await host.reload({ waitUntil: "load" });
  frame = await waitReady(host);
  mount = new URL(frame.url()).pathname;
  assert.deepEqual(await listSites(frame), [SITE]);
  // and the page saved earlier came back with it
  const page = await frame.evaluate(async (site) => {
    const manifest = await (
      await fetch("_sites/" + site + "/site.json")
    ).json();
    return (
      await fetch("_sites/" + site + "/" + manifest.items[0].location)
    ).text();
  }, SITE);
  assert.match(page, /Saved from the smoke test/);
});

test("a second tab does not save over the first", async () => {
  const second = await browser.newPage();
  await second.goto(server.url, { waitUntil: "load" });
  await waitReady(second);
  assert.match(
    await second.$eval("#note", (el) => el.textContent),
    /^Not being saved: HAXcms is already open in another tab/,
  );
  await second.close();
});

// The folder picker is a native dialog, so the tests hand the page a folder
// the same way the picker would: a directory handle. These come from the
// browser's private file system, which is the same kind of object.
async function pickFolder(page, name, files) {
  // someone clicking a button in a tab has that tab in front
  await page.bringToFront();
  await page.evaluate(
    async (name, files) => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle(name, { create: true });
      for (const [file, text] of Object.entries(files || {})) {
        const parts = file.split("/");
        let dir = folder;
        for (const part of parts.slice(0, -1)) {
          dir = await dir.getDirectoryHandle(part, { create: true });
        }
        const writable = await (
          await dir.getFileHandle(parts[parts.length - 1], { create: true })
        ).createWritable();
        await writable.write(text);
        await writable.close();
      }
      globalThis.showDirectoryPicker = async () => folder;
    },
    name,
    files,
  );
  await page.click("#folder-button");
}

test("a folder that is not for HAX sites is refused, and says why", async () => {
  await pickFolder(host, "documents", { "taxes.txt": "private" });
  await host.waitForFunction(
    () =>
      /has other things in it/.test(
        document.getElementById("note").textContent,
      ),
    { timeout: 10000 },
  );
  await pickFolder(host, "one-site", { "site.json": "{}" });
  await host.waitForFunction(
    () =>
      /is a single HAX site/.test(document.getElementById("note").textContent),
    { timeout: 10000 },
  );
  // still saving where it was
  assert.deepEqual(await listSites(frame), [SITE]);
});

test("Save to a folder: sites are written there, and later saves follow", async () => {
  await pickFolder(host, "my-hax-sites");
  await host.waitForFunction(
    () =>
      /^Saving to the folder "my-hax-sites"/.test(
        document.getElementById("note").textContent,
      ),
    { timeout: 30000 },
  );
  let files = await listFolder(host, "my-hax-sites");
  assert.ok(files.includes(SITE + "/site.json"), files.slice(0, 5).join(", "));

  // a new site made after the switch lands in the folder
  const created = await frame.evaluate(async () => {
    const s = globalThis.appSettings;
    const response = await fetch("system/api/v1/sites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + s.jwt,
        "x-haxcms-user-token": s.userToken,
      },
      body: JSON.stringify({
        site: { name: "second-site" },
        build: { type: "own", structure: "course", items: null, files: null },
        theme: { name: "clean-one", variables: {} },
      }),
    });
    return response.status;
  });
  assert.equal(created, 200);
  files = await listFolder(host, "my-hax-sites");
  assert.ok(files.includes("second-site/site.json"));

  // coming back later: the folder is remembered and HAXcms starts from it
  await host.reload({ waitUntil: "load" });
  frame = await waitReady(host);
  mount = new URL(frame.url()).pathname;
  assert.match(
    await host.$eval("#note", (el) => el.textContent),
    /^Saving to the folder "my-hax-sites"/,
  );
  assert.deepEqual(await listSites(frame), ["second-site", SITE].sort());
});

test("a save that cannot reach the folder is reported as failed", async () => {
  // the folder disappears (moved, deleted, drive unplugged)
  await host.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("my-hax-sites", { recursive: true });
  });
  const saved = await frame.evaluate(async (site) => {
    const s = globalThis.appSettings;
    const manifest = await (
      await fetch("_sites/" + site + "/site.json")
    ).json();
    const item = manifest.items[0];
    const response = await fetch(
      "_sites/" + site + "/x/api/v1/content/" + item.id,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + s.jwt,
          "x-haxcms-site-token": s.siteToken,
        },
        body: JSON.stringify({
          site: { name: site },
          body:
            '<page-break title="' +
            item.title +
            '" item-id="' +
            item.id +
            '"></page-break><p>This must not be reported as saved</p>',
        }),
      },
    );
    return { status: response.status, body: await response.text() };
  }, SITE);
  assert.equal(saved.status, 500, saved.body);
  assert.equal(
    JSON.parse(saved.body).data.code,
    "BROWSER_STORAGE_WRITE_FAILED",
  );
  // and the bar says so
  assert.equal(
    await host.$eval("#status", (el) => el.textContent),
    "Not saved: your last change did not reach storage",
  );
  assert.equal(await host.$eval("#dot", (el) => el.dataset.state), "error");
});

test("Stop using the folder goes back to the browser's storage", async () => {
  await host.click("#browser-button");
  await host.waitForFunction(
    () =>
      /^Saved in this browser/.test(
        document.getElementById("note").textContent,
      ),
    { timeout: 60000 },
  );
  frame = await waitReady(host);
  mount = new URL(frame.url()).pathname;
  // the browser's own copy only has what was made before the folder
  assert.deepEqual(await listSites(frame), [SITE]);
});

test("HAXcms comes back signed in every time it is restarted", async () => {
  // changing where sites are saved restarts HAXcms; the dashboard must not
  // meet the user with its login form afterwards (the second and later
  // starts are the fast ones, with every file already cached)
  for (let round = 0; round < 4; round++) {
    await host.evaluate(() => {
      document.getElementById("browser-button").click();
    });
    await host.waitForFunction(
      () => document.getElementById("dot").dataset.state !== "ready",
      { timeout: 10000 },
    );
    frame = await waitReady(host);
    mount = new URL(frame.url()).pathname;
    const signedIn = await frame
      .waitForFunction(
        () => {
          const app = document.querySelector("app-hax");
          return !!(app && app.store && app.store.isLoggedIn && app.store.jwt);
        },
        { timeout: 15000 },
      )
      .then(
        () => true,
        () => false,
      );
    assert.equal(signedIn, true, "signed in after restart " + (round + 1));
  }
  assert.deepEqual(await listSites(frame), [SITE]);
});

test("a site can be saved as a template (skeleton) and its skeleton downloaded", async () => {
  const result = await frame.evaluate(async (site) => {
    const s = globalThis.appSettings;
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + s.jwt,
      "x-haxcms-user-token": s.userToken,
    };
    // answer, or say that nothing came back
    const call = async (path, method) => {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 30000);
      try {
        const response = await fetch(path, {
          method,
          headers,
          body:
            method === "GET"
              ? undefined
              : JSON.stringify({ site: { name: site } }),
          signal: stop.signal,
        });
        return {
          status: response.status,
          text: (await response.text()).slice(0, 300),
        };
      } catch (error) {
        return { status: 0, text: "no answer: " + String(error) };
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      saved: await call(
        "system/api/v1/sites/" + site + "/save-as-template",
        "POST",
      ),
      skeleton: await call(
        "system/api/v1/sites/" + site + "/download-skeleton",
        "POST",
      ),
      listed: await call("system/api/v1/skeletons", "GET"),
    };
  }, SITE);
  const detail =
    JSON.stringify(result, null, 1) + "\n" + runtimeErrors.slice(-3).join("\n");
  assert.equal(result.saved.status, 200, detail);
  assert.equal(result.skeleton.status, 200, detail);
  assert.equal(result.listed.status, 200, detail);
  // the dashboard's template list now offers it
  assert.match(result.listed.text, new RegExp(SITE), detail);
});

test("HAXcms's own Download site gives a zip of the site", async () => {
  const result = await frame.evaluate(async (site) => {
    const s = globalThis.appSettings;
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + s.jwt,
      "x-haxcms-user-token": s.userToken,
    };
    const response = await fetch("system/api/v1/sites/" + site + "/download", {
      method: "POST",
      headers,
      body: JSON.stringify({ site: { name: site } }),
    });
    const text = await response.text();
    if (response.status !== 200) {
      return { status: response.status, text: text.slice(0, 300) };
    }
    const link = JSON.parse(text).data.link;
    const zip = new Uint8Array(await (await fetch(link)).arrayBuffer());
    return {
      status: response.status,
      name: JSON.parse(text).data.name,
      // a zip file starts with "PK"
      signature: String.fromCharCode(zip[0], zip[1]),
      bytes: zip.length,
    };
  }, SITE);
  assert.equal(
    result.status,
    200,
    result.text + "\n" + runtimeErrors.join("\n"),
  );
  assert.equal(result.name, SITE + ".zip");
  assert.equal(result.signature, "PK");
  assert.ok(result.bytes > 1000, "zip has content: " + result.bytes);
});

// ---- publishing (haxtheweb/issues#3341) --------------------------------

test("without a publish broker, Publish points to Download site and the CLI", async () => {
  await host.bringToFront();
  await host.click("#publish-button");
  await host.waitForFunction(() => document.getElementById("publish").open, {
    timeout: 10000,
  });
  const shown = await host.evaluate(() => ({
    none: !document.getElementById("publish-none").hidden,
    fields: !document.getElementById("publish-fields").hidden,
    submit: !document.getElementById("publish-submit").hidden,
  }));
  assert.deepEqual(shown, { none: true, fields: false, submit: false });
  await host.click("#publish-cancel");
  assert.equal(
    await host.evaluate(() => document.getElementById("publish").open),
    false,
  );
});

test("Publish states the size limit and stops bigger sites before uploading", async () => {
  const require = createRequire(import.meta.url);
  const deploy = require("../api/surge/deploy.js");
  let uploads = 0;
  server.setApi((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (pathname === "/api/status") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ broker: 1, publish: { surge: { maxBytes: 1024 } } }),
      );
      return;
    }
    if (pathname === "/api/surge/deploy") {
      uploads++;
      deploy(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    await host.bringToFront();
    await host.click("#publish-button");
    await host.waitForFunction(
      () =>
        document.getElementById("publish").open &&
        !document.getElementById("publish-limit").hidden,
      { timeout: 15000 },
    );
    assert.match(
      await host.$eval("#publish-limit", (el) => el.textContent),
      /up to 1 KB.*HAX CLI/,
    );
    await host.select("#publish-site", SITE);
    await host.$eval("#publish-domain", (el) => {
      el.value = "too-big.surge.sh";
    });
    await host.type("#publish-token", "token0123456789");
    await host.click("#publish-submit");
    await host.waitForFunction(
      () => document.getElementById("publish-status").dataset.state === "error",
      { timeout: 60000 },
    );
    assert.match(
      await host.$eval("#publish-status", (el) => el.textContent),
      /over the 1 KB.*hax site site:surge/,
    );
    assert.equal(uploads, 0);
    // forget the token so the next test starts signed out
    await host.click("#publish-forget");
    await host.click("#publish-cancel");
  } finally {
    server.setApi(null);
  }
});

test("Publish packs the site and sends it through the broker to Surge", async () => {
  const require = createRequire(import.meta.url);
  // a stand-in for the Surge API
  const received = [];
  const surge = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks),
      });
      res.setHeader("content-type", "application/x-ndjson");
      res.end('{"type":"progress"}\n{"type":"info"}\n');
    });
  });
  await new Promise((resolve) => surge.listen(0, "127.0.0.1", resolve));
  const restoreFetch = redirectSurge(
    "http://127.0.0.1:" + surge.address().port,
  );
  const routes = {
    "/api/status": require("../api/status.js"),
    "/api/surge/token": require("../api/surge/token.js"),
    "/api/surge/deploy": require("../api/surge/deploy.js"),
  };
  server.setApi((req, res) => {
    const route = routes[new URL(req.url, "http://x").pathname];
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    Promise.resolve(route(req, res)).catch((e) => {
      res.statusCode = 500;
      res.end(String(e));
    });
  });
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-publish-"));
  try {
    await host.bringToFront();
    await host.click("#publish-button");
    await host.waitForFunction(
      (site) =>
        document.getElementById("publish").open &&
        !document.getElementById("publish-fields").hidden &&
        Array.from(document.querySelectorAll("#publish-site option")).some(
          (option) => option.value === site,
        ),
      { timeout: 15000 },
      SITE,
    );
    await host.select("#publish-site", SITE);
    // a first publish suggests a free address made from the site's name
    assert.match(
      await host.$eval("#publish-domain", (el) => el.value),
      new RegExp("^" + SITE + "-[0-9a-f]{6}\\.surge\\.sh$"),
    );
    await host.$eval("#publish-domain", (el) => {
      el.value = "smoke-test.surge.sh";
    });
    await host.type("#publish-token", "token0123456789");
    await host.click("#publish-submit");
    await host.waitForFunction(
      () =>
        ["ready", "error"].includes(
          document.getElementById("publish-status").dataset.state,
        ),
      { timeout: 60000 },
    );
    const result = await host.evaluate(() => ({
      state: document.getElementById("publish-status").dataset.state,
      text: document.getElementById("publish-status").textContent,
      link: (document.querySelector("#publish-status a") || {}).href,
      signedIn: !document.getElementById("publish-signed-in").hidden,
      stored: JSON.stringify(Object.assign({}, globalThis.localStorage)),
    }));
    assert.equal(result.state, "ready", result.text);
    assert.equal(result.link, "https://smoke-test.surge.sh/");
    // the token stays in this tab's memory: not in storage
    assert.equal(result.signedIn, true);
    assert.match(result.stored, /smoke-test\.surge\.sh/);
    assert.doesNotMatch(result.stored, /token0123456789/);

    assert.equal(received.length, 1);
    assert.equal(received[0].method, "PUT");
    assert.equal(received[0].url, "/smoke-test.surge.sh");
    assert.equal(
      received[0].authorization,
      "Basic " + Buffer.from("token:token0123456789").toString("base64"),
    );
    // what Surge got is the site, as the HAX CLI publishes it
    const archive = path.join(unpacked, "site.tar.gz");
    fs.writeFileSync(archive, received[0].body);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", unpacked], {
      encoding: "utf8",
    });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.ok(fs.existsSync(path.join(unpacked, "site.json")));
    assert.equal(
      fs.readFileSync(path.join(unpacked, "index.html"), "utf8"),
      fs.readFileSync(path.join(unpacked, "ghpages.html"), "utf8"),
    );
    assert.equal(fs.existsSync(path.join(unpacked, "build")), false);
    // llms-full.txt, exactly as the in-browser HAXcms answers it
    const served = await frame.evaluate(
      async (base, site) => {
        const response = await fetch(
          base + "_sites/" + site + "/llms-full.txt",
        );
        return { status: response.status, text: await response.text() };
      },
      mount,
      SITE,
    );
    assert.equal(served.status, 200);
    assert.equal(
      fs.readFileSync(path.join(unpacked, "llms-full.txt"), "utf8"),
      served.text,
    );
    await host.click("#publish-cancel");
  } finally {
    server.setApi(null);
    restoreFetch();
    surge.close();
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
});

test("the code editor finds its files (it loads them from inside a frame)", async () => {
  const page = await browser.newPage();
  const missing = [];
  page.on("response", (response) => {
    if (response.status() >= 400) {
      missing.push(response.status() + " " + response.url());
    }
  });
  page.on("requestfailed", (request) => {
    missing.push("failed " + request.url());
  });
  await page.goto(new URL(mount + "_sites/" + SITE + "/", server.url).href, {
    waitUntil: "load",
  });
  const siteFrame = page.frames().find((f) => f !== page.mainFrame());
  await siteFrame.waitForFunction(
    () => document.querySelector("haxcms-site-builder"),
    { timeout: 30000 },
  );
  const editor = await siteFrame.evaluate(async () => {
    await import(
      new URL(
        "build/es6/node_modules/@haxtheweb/code-editor/code-editor.js",
        document.baseURI,
      ).href
    );
    const element = document.createElement("code-editor");
    document.body.appendChild(element);
    const started = Date.now();
    // monaco is there once its frame has built an editor
    while (Date.now() - started < 30000) {
      const inner =
        element.shadowRoot &&
        element.shadowRoot.querySelector("monaco-element");
      const iframe =
        inner && inner.shadowRoot && inner.shadowRoot.querySelector("iframe");
      if (iframe && iframe.contentWindow && iframe.contentWindow.monaco) {
        return { ready: true, libPath: element.libPath };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ready: false, libPath: element.libPath, base: document.baseURI };
  });
  await page.close();
  const detail = JSON.stringify(editor) + "\n" + missing.join("\n");
  assert.equal(editor.ready, true, detail);
  assert.deepEqual(
    missing.filter((entry) => /monaco/.test(entry)),
    [],
  );
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
