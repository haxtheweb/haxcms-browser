// Cloud storage (src/runtime/remote.cjs) behind the same DirectoryStorage
// a folder uses: load, flush and removals go through each service's API.
// The services here are stand-ins that keep files in memory and answer the
// requests remote.cjs makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { Volume, createFsFromVolume } from "memfs";

const require = createRequire(import.meta.url);
const remote = require("../src/runtime/remote.cjs");
const { DirectoryStorage } = require("../src/runtime/storage.cjs");

const ROOT = "/haxcms/_sites";

function volume(files) {
  const fs = createFsFromVolume(new Volume());
  fs.mkdirSync(ROOT, { recursive: true });
  for (const [file, content] of Object.entries(files || {})) {
    fs.mkdirSync(path.posix.dirname(ROOT + "/" + file), { recursive: true });
    fs.writeFileSync(ROOT + "/" + file, content);
  }
  return fs;
}

// ---- a Dropbox stand-in: paths -> { folder } | { bytes, modified } ------

function fakeDropbox(options) {
  const store = new Map([["", { folder: true }]]);
  const log = [];
  let clock = 1000;
  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { "content-type": "application/json" },
    });
  const entry = (p) => {
    const item = store.get(p.toLowerCase());
    const name = p.split("/").pop();
    return item.folder
      ? { ".tag": "folder", name, path_lower: p.toLowerCase(), path_display: p }
      : {
          ".tag": "file",
          name,
          path_lower: p.toLowerCase(),
          path_display: p,
          size: item.bytes.length,
          server_modified: new Date(item.modified).toISOString(),
        };
  };
  async function fetchFn(url, init) {
    const auth = init.headers.authorization;
    log.push({ url, auth });
    if (options && options.expire && auth === "Bearer old-token") {
      return json({ error: "expired_access_token" }, 401);
    }
    const route = url.replace(
      /^https:\/\/(api|content)\.dropboxapi\.com\/2\/files/,
      "",
    );
    const arg = init.headers["dropbox-api-arg"]
      ? JSON.parse(init.headers["dropbox-api-arg"])
      : init.body
        ? JSON.parse(init.body)
        : {};
    if (route === "/list_folder") {
      const prefix = arg.path.toLowerCase();
      const entries = [];
      for (const key of store.keys()) {
        if (
          key !== prefix &&
          key.startsWith(prefix + "/") &&
          key.slice(prefix.length + 1).indexOf("/") === -1
        ) {
          entries.push(entry(store.get(key).display || key));
        }
      }
      return json({ entries, has_more: false, cursor: "c" });
    }
    if (route === "/create_folder_v2") {
      store.set(arg.path.toLowerCase(), { folder: true, display: arg.path });
      return json({ metadata: entry(arg.path) });
    }
    if (route === "/upload") {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      clock += 1000;
      store.set(arg.path.toLowerCase(), {
        bytes,
        modified: clock,
        display: arg.path,
      });
      return json(entry(arg.path));
    }
    if (route === "/download") {
      const item = store.get(arg.path.toLowerCase());
      return new Response(item.bytes);
    }
    if (route === "/delete_v2") {
      for (const key of Array.from(store.keys())) {
        if (
          key === arg.path.toLowerCase() ||
          key.startsWith(arg.path.toLowerCase() + "/")
        ) {
          store.delete(key);
        }
      }
      return json({ metadata: {} });
    }
    return json({ error: "unknown " + route }, 404);
  }
  return { store, log, fetch: fetchFn };
}

test("a site saves to and loads back from cloud storage like a folder", async () => {
  const dropbox = fakeDropbox();
  const handle = await remote.createRemoteRoot({
    provider: "dropbox",
    getToken: async () => "token",
    fetch: dropbox.fetch,
  });
  const fs = volume({
    "one/site.json": '{"title":"One"}',
    "one/pages/a/index.html": "<p>a</p>",
    "one/files/photo é.jpg": "jpeg",
  });
  const storage = new DirectoryStorage({
    fs,
    path: path.posix,
    handle,
    root: ROOT,
  });
  const written = await storage.flush();
  assert.equal(written.written, 3);
  assert.ok(dropbox.store.has("/one/site.json"));
  assert.ok(dropbox.store.has("/one/files/photo é.jpg"));
  // non-ASCII names travel in Dropbox's header as \u escapes
  assert.ok(dropbox.log.some((entry) => entry.url.endsWith("/upload")));

  // a change and a removal
  fs.writeFileSync(ROOT + "/one/site.json", '{"title":"One, again"}');
  fs.unlinkSync(ROOT + "/one/pages/a/index.html");
  const second = await storage.flush();
  assert.equal(second.written, 1);
  assert.equal(second.removed, 1);
  assert.equal(dropbox.store.has("/one/pages/a/index.html"), false);

  // another session starts from the cloud
  const fresh = volume();
  const again = await remote.createRemoteRoot({
    provider: "dropbox",
    getToken: async () => "token",
    fetch: dropbox.fetch,
  });
  const loaded = new DirectoryStorage({
    fs: fresh,
    path: path.posix,
    handle: again,
    root: ROOT,
  });
  const result = await loaded.load();
  assert.equal(result.files, 2);
  assert.equal(
    fresh.readFileSync(ROOT + "/one/site.json", "utf8"),
    '{"title":"One, again"}',
  );
  assert.equal(
    fresh.readFileSync(ROOT + "/one/files/photo é.jpg", "utf8"),
    "jpeg",
  );
});

test("an expired sign-in is renewed once through the page, then retried", async () => {
  const dropbox = fakeDropbox({ expire: true });
  const asked = [];
  const handle = await remote.createRemoteRoot({
    provider: "dropbox",
    getToken: async (force) => {
      asked.push(force);
      return force ? "new-token" : "old-token";
    },
    fetch: dropbox.fetch,
  });
  const fs = volume({ "one/site.json": "{}" });
  const storage = new DirectoryStorage({
    fs,
    path: path.posix,
    handle,
    root: ROOT,
  });
  await storage.flush();
  assert.deepEqual(asked, [false, true]);
  assert.ok(dropbox.store.has("/one/site.json"));
});

test("a failed upload fails the save and leaves the cloud copy as it was", async () => {
  const dropbox = fakeDropbox();
  const handle = await remote.createRemoteRoot({
    provider: "dropbox",
    getToken: async () => "token",
    fetch: dropbox.fetch,
  });
  const fs = volume({ "one/site.json": "first" });
  const storage = new DirectoryStorage({
    fs,
    path: path.posix,
    handle,
    root: ROOT,
  });
  await storage.flush();
  const failing = async (url, init) =>
    url.endsWith("/upload")
      ? new Response("{}", { status: 507 })
      : dropbox.fetch(url, init);
  const brokenHandle = await remote.createRemoteRoot({
    provider: "dropbox",
    getToken: async () => "token",
    fetch: failing,
  });
  const broken = new DirectoryStorage({
    fs,
    path: path.posix,
    handle: brokenHandle,
    root: ROOT,
  });
  await broken.load();
  fs.writeFileSync(ROOT + "/one/site.json", "second");
  await assert.rejects(broken.flush());
  assert.equal(
    new TextDecoder().decode(dropbox.store.get("/one/site.json").bytes),
    "first",
  );
});

// ---- WebDAV ------------------------------------------------------------

function fakeWebdav(base) {
  const prefix = decodeURIComponent(new URL(base).pathname);
  const store = new Map([[prefix, { folder: true }]]);
  async function fetchFn(url, init) {
    assert.equal(
      init.headers.authorization,
      "Basic " + Buffer.from("ada:app pass é").toString("base64"),
    );
    const target = new URL(url);
    const key = decodeURIComponent(target.pathname);
    const method = (init && init.method) || "GET";
    if (method === "PROPFIND") {
      if (!store.has(key)) {
        return new Response("", { status: 404 });
      }
      let xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">';
      // servers encode differently: this one encodes the space as %20 and
      // leaves é raw
      const href = (p) => p.replace(/ /g, "%20");
      xml +=
        "<d:response><d:href>" +
        href(key) +
        "</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>";
      for (const [p, item] of store) {
        if (
          p !== key &&
          p.startsWith(key) &&
          p.slice(key.length).replace(/\/$/, "").indexOf("/") === -1
        ) {
          xml +=
            "<d:response><d:href>" +
            href(p) +
            "</d:href><d:propstat><d:prop>" +
            (item.folder
              ? "<d:resourcetype><d:collection/></d:resourcetype>"
              : "<d:resourcetype/><d:getcontentlength>" +
                item.bytes.length +
                "</d:getcontentlength><d:getlastmodified>" +
                new Date(item.modified).toUTCString() +
                "</d:getlastmodified>") +
            "</d:prop></d:propstat></d:response>";
        }
      }
      return new Response(xml + "</d:multistatus>", { status: 207 });
    }
    if (method === "MKCOL") {
      store.set(key, { folder: true });
      return new Response("", { status: 201 });
    }
    if (method === "PUT") {
      store.set(key, {
        bytes: new Uint8Array(await new Response(init.body).arrayBuffer()),
        modified: Date.now(),
      });
      return new Response("", { status: 201 });
    }
    if (method === "GET") {
      return new Response(store.get(key).bytes);
    }
    if (method === "DELETE") {
      for (const p of Array.from(store.keys())) {
        if (p === key || p.startsWith(key)) {
          store.delete(p);
        }
      }
      return new Response("", { status: 204 });
    }
    return new Response("", { status: 405 });
  }
  return { store, fetch: fetchFn };
}

test("WebDAV: saves, lists (whatever the server's encoding) and loads", async () => {
  const base = "https://cloud.example.org/remote.php/dav/files/ada/HAX sites/";
  const dav = fakeWebdav(base);
  const options = {
    provider: "webdav",
    webdav: { url: base, username: "ada", password: "app pass é" },
    fetch: dav.fetch,
  };
  const fs = volume({
    "my site/site.json": "{}",
    "my site/files/é.txt": "accent",
  });
  const storage = new DirectoryStorage({
    fs,
    path: path.posix,
    handle: await remote.createRemoteRoot(options),
    root: ROOT,
  });
  await storage.flush();
  assert.ok(
    dav.store.has("/remote.php/dav/files/ada/HAX sites/my site/files/é.txt"),
  );
  const fresh = volume();
  const loaded = new DirectoryStorage({
    fs: fresh,
    path: path.posix,
    handle: await remote.createRemoteRoot(options),
    root: ROOT,
  });
  assert.equal((await loaded.load()).files, 2);
  assert.equal(
    fresh.readFileSync(ROOT + "/my site/files/é.txt", "utf8"),
    "accent",
  );
});

test("WebDAV addresses must be https and carry no credentials", () => {
  assert.ok(remote.validWebdavUrl("https://cloud.example.org/dav/"));
  assert.ok(remote.validWebdavUrl("http://localhost:8080/dav/"));
  for (const bad of [
    "http://cloud.example.org/dav/",
    "https://user:pass@cloud.example.org/dav/",
    "https://cloud.example.org/dav/?x=1",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(remote.validWebdavUrl(bad), null, bad);
  }
});

test("PROPFIND answers parse with any namespace prefix", () => {
  const parsed = remote.parseMultistatus(
    '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a/b%20c/</D:href>' +
      "<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>" +
      "<D:response><D:href>/a/b%20c/x&amp;y.txt</D:href><D:propstat><D:prop><D:resourcetype/>" +
      "<D:getcontentlength>12</D:getcontentlength><D:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</D:getlastmodified>" +
      "</D:prop></D:propstat></D:response></D:multistatus>",
  );
  assert.deepEqual(parsed, [
    { href: "/a/b%20c/", collection: true, modified: 0, size: 0 },
    {
      href: "/a/b%20c/x&y.txt",
      collection: false,
      modified: Date.UTC(2025, 0, 1),
      size: 12,
    },
  ]);
});

test("Dropbox arguments are ASCII for its header", () => {
  assert.equal(remote.asciiJson({ path: "/é" }), '{"path":"/\\u00e9"}');
});

test("unknown providers and a missing sign-in are refused", async () => {
  await assert.rejects(
    remote.createRemoteRoot({
      provider: "__proto__",
      getToken: async () => "t",
    }),
    /not a storage provider/,
  );
  await assert.rejects(
    remote.createRemoteRoot({ provider: "google", getToken: async () => null }),
    /Sign in/,
  );
});

// ---- the other backends' requests ---------------------------------------

test("Google Drive: the HAXcms folder is found or made, files go to Drive's trash", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({
      url,
      method: (init && init.method) || "GET",
      body: init && init.body,
    });
    if (url.includes("/drive/v3/files?q=")) {
      return Response.json({ files: [] });
    }
    return Response.json({
      id: "folder-1",
      name: "HAXcms sites",
      mimeType: "application/vnd.google-apps.folder",
      modifiedTime: "2025-01-01T00:00:00Z",
    });
  };
  const root = await remote.createRemoteRoot({
    provider: "google",
    getToken: async () => "t",
    fetch: fetchFn,
  });
  assert.equal(root.item.id, "folder-1");
  // looked for the folder in My Drive, then made it there
  assert.match(
    decodeURIComponent(calls[0].url),
    /name = 'HAXcms sites'.*'root' in parents/,
  );
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), {
    name: "HAXcms sites",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["root"],
  });
  await remote.backends
    .google(async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      return Response.json({});
    })
    .remove({ id: "file 1", name: "x" });
  const removal = calls[calls.length - 1];
  assert.equal(removal.method, "PATCH");
  assert.match(removal.url, /files\/file%201$/);
  assert.deepEqual(JSON.parse(removal.body), { trashed: true });
});

test("OneDrive: only the app folder, and paging stays on Graph", async () => {
  const calls = [];
  const backend = remote.backends.microsoft(async (url) => {
    calls.push(url);
    if (url.includes("approot")) {
      return Response.json({ id: "app", name: "HAXcms", folder: {} });
    }
    if (calls.length === 2) {
      return Response.json({
        value: [{ id: "1", name: "a", folder: {} }],
        "@odata.nextLink": "https://evil.example/next",
      });
    }
    return Response.json({ value: [] });
  });
  const rootItem = await backend.root();
  assert.equal(rootItem.id, "app");
  assert.match(calls[0], /\/me\/drive\/special\/approot/);
  const items = await backend.list(rootItem);
  assert.equal(items.length, 1);
  // a next link off Graph is not followed
  assert.equal(calls.length, 2);
});

test("Box: uploads name the parent folder, removals go to the trash", async () => {
  const calls = [];
  const backend = remote.backends.box(async (url, init) => {
    calls.push({
      url,
      method: (init && init.method) || "GET",
      body: init && init.body,
    });
    return Response.json({
      entries: [{ id: "9", type: "file", name: "a.txt" }],
    });
  });
  await backend.write({ id: "42" }, "a.txt", null, new Uint8Array([1]));
  assert.equal(calls[0].url, "https://upload.box.com/api/2.0/files/content");
  assert.deepEqual(JSON.parse(calls[0].body.get("attributes")), {
    name: "a.txt",
    parent: { id: "42" },
  });
  await backend.remove({ id: "7", kind: "directory", name: "d" });
  assert.equal(calls[1].method, "DELETE");
  assert.equal(
    calls[1].url,
    "https://api.box.com/2.0/folders/7?recursive=true",
  );
});
