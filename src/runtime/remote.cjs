/**
 * Cloud storage as a folder (haxtheweb/issues#3341).
 *
 * storage.cjs keeps the sites folder and a FileSystemDirectoryHandle the
 * same. This file makes a cloud drive look like one: RemoteDirectory and
 * RemoteFile have the parts of the directory-handle API storage.cjs uses
 * (getDirectoryHandle, getFileHandle, entries, removeEntry, getFile,
 * createWritable), and a small backend per service does the actual calls.
 * So saving, loading and picking up outside changes work the same as for a
 * folder on the computer, with the same rules:
 *
 * - a write is uploaded whole on close(); if the upload fails, close()
 *   throws and the file in the drive is left as it was
 * - removing goes to the service's trash or recycle bin where it has one
 * - nothing outside the HAXcms folder in the drive is read or written: each
 *   backend starts from its own folder (Google Drive: a "HAXcms sites"
 *   folder the app made; OneDrive: the app's own folder; Dropbox: the app
 *   folder; Box: a "HAXcms sites" folder; WebDAV: the address given)
 *
 * Backends: google (Drive), microsoft (OneDrive), dropbox, box, webdav
 * (Nextcloud, ownCloud and other WebDAV servers that allow this page's
 * origin). All of them are called straight from the browser.
 *
 * Every backend call goes through `call(url, init)`, which adds the sign-in
 * and renews it once when the service says it has run out (see
 * createRemoteRoot).
 */

const FOLDER_NAME = "HAXcms sites";

// ---- the handle API ------------------------------------------------------

class RemoteFile {
  constructor(backend, parent, item) {
    this.kind = "file";
    this.name = item.name;
    this.backend = backend;
    this.parent = parent;
    this.item = item;
  }

  // Lazy: lastModified is known from the listing; the bytes are only
  // downloaded when asked for (storage.cjs's refresh() skips files whose
  // lastModified has not changed).
  async getFile() {
    const backend = this.backend;
    const item = this.item;
    return {
      name: item.name,
      lastModified: item.modified || 0,
      size: item.size || 0,
      arrayBuffer: async () => {
        const bytes = await backend.read(item);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      },
    };
  }

  async createWritable() {
    const chunks = [];
    const file = this;
    return {
      async write(data) {
        if (data instanceof Uint8Array) {
          chunks.push(data);
        } else if (data instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(data));
        } else if (typeof data === "string") {
          chunks.push(new TextEncoder().encode(data));
        } else if (data && typeof data.arrayBuffer === "function") {
          chunks.push(new Uint8Array(await data.arrayBuffer()));
        } else {
          throw new Error("unsupported write");
        }
      },
      async close() {
        let length = 0;
        for (const chunk of chunks) {
          length += chunk.length;
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const existing = file.item.id ? file.item : null;
        const saved = await file.backend.write(
          file.parent.item,
          file.name,
          existing,
          bytes,
        );
        file.item = Object.assign({}, file.item, saved, { name: file.name });
        file.parent.remember(file.item);
      },
      async abort() {
        chunks.length = 0;
      },
    };
  }
}

// One RemoteDirectory per folder, shared: storage.cjs walks down from the
// root for every file it writes, and each folder is listed only once.
// (Changes made to the drive elsewhere while HAXcms runs are picked up the
// next time HAXcms starts.)
function directoryFor(backend, item, cache) {
  const key = item.kind + ":" + item.id;
  let dir = cache.get(key);
  if (!dir) {
    dir = new RemoteDirectory(backend, item, cache);
    cache.set(key, dir);
  }
  return dir;
}

class RemoteDirectory {
  constructor(backend, item, cache) {
    this.kind = "directory";
    this.name = item.name;
    this.backend = backend;
    this.item = item;
    this.cache = cache || new Map();
    // name -> item, filled by the first listing
    this.children = null;
  }

  async list() {
    if (!this.children) {
      const map = new Map();
      for (const child of await this.backend.list(this.item)) {
        map.set(child.name, child);
      }
      this.children = map;
    }
    return this.children;
  }

  remember(item) {
    if (this.children) {
      this.children.set(item.name, item);
    }
  }

  async getDirectoryHandle(name, options) {
    const children = await this.list();
    let item = children.get(name);
    if (item && item.kind !== "directory") {
      throw typeMismatch(name);
    }
    if (!item) {
      if (!options || !options.create) {
        throw notFound(name);
      }
      item = await this.backend.mkdir(this.item, name);
      item.kind = "directory";
      item.name = name;
      children.set(name, item);
    }
    return directoryFor(this.backend, item, this.cache);
  }

  async getFileHandle(name, options) {
    const children = await this.list();
    const item = children.get(name);
    if (item && item.kind !== "file") {
      throw typeMismatch(name);
    }
    if (!item) {
      if (!options || !options.create) {
        throw notFound(name);
      }
      // nothing is uploaded until the file is written
      return new RemoteFile(this.backend, this, { name, kind: "file" });
    }
    return new RemoteFile(this.backend, this, item);
  }

  async *entries() {
    const children = await this.list();
    for (const item of Array.from(children.values())) {
      yield [
        item.name,
        item.kind === "directory"
          ? directoryFor(this.backend, item, this.cache)
          : new RemoteFile(this.backend, this, item),
      ];
    }
  }

  async removeEntry(name) {
    const children = await this.list();
    const item = children.get(name);
    if (!item) {
      throw notFound(name);
    }
    await this.backend.remove(item, this.item);
    children.delete(name);
    this.cache.delete(item.kind + ":" + item.id);
  }
}

function notFound(name) {
  const error = new Error(name + " was not found");
  error.name = "NotFoundError";
  return error;
}

function typeMismatch(name) {
  const error = new Error(name + " is not the expected kind of entry");
  error.name = "TypeMismatchError";
  return error;
}

// ---- helpers for backends -------------------------------------------------

async function ok(response, what) {
  if (response.ok) {
    return response;
  }
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    detail = "";
  }
  const error = new Error(
    what + " failed (" + response.status + ")" + (detail ? ": " + detail : ""),
  );
  error.status = response.status;
  throw error;
}

async function json(response, what) {
  return (await ok(response, what)).json();
}

async function bytesOf(response, what) {
  return new Uint8Array(await (await ok(response, what)).arrayBuffer());
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function encodeSegment(name) {
  return encodeURIComponent(name);
}

// Dropbox reads its arguments from a header, which must be plain ASCII
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

// ---- Google Drive (scope drive.file) -------------------------------------

function googleBackend(call) {
  const API = "https://www.googleapis.com/drive/v3/files";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const FOLDER = "application/vnd.google-apps.folder";
  const FIELDS = "id,name,mimeType,modifiedTime,size";
  const toItem = (file) => ({
    id: file.id,
    name: file.name,
    kind: file.mimeType === FOLDER ? "directory" : "file",
    modified: time(file.modifiedTime),
    size: Number(file.size) || 0,
  });
  const quote = (value) =>
    "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  return {
    async root() {
      const q =
        "name = " +
        quote(FOLDER_NAME) +
        " and mimeType = " +
        quote(FOLDER) +
        " and 'root' in parents and trashed = false";
      const found = await json(
        await call(
          API + "?q=" + encodeURIComponent(q) + "&fields=files(" + FIELDS + ")",
        ),
        "Finding the HAXcms folder in Google Drive",
      );
      if (found.files && found.files.length) {
        return toItem(found.files[0]);
      }
      return this.mkdir({ id: "root" }, FOLDER_NAME);
    },
    async list(dir) {
      const items = [];
      let pageToken = "";
      do {
        const q = quote(dir.id) + " in parents and trashed = false";
        const page = await json(
          await call(
            API +
              "?q=" +
              encodeURIComponent(q) +
              "&pageSize=1000&fields=nextPageToken,files(" +
              FIELDS +
              ")" +
              (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""),
          ),
          "Listing a Google Drive folder",
        );
        for (const file of page.files || []) {
          items.push(toItem(file));
        }
        pageToken = page.nextPageToken || "";
      } while (pageToken);
      return items;
    },
    async mkdir(dir, name) {
      return toItem(
        await json(
          await call(API + "?fields=" + FIELDS, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, mimeType: FOLDER, parents: [dir.id] }),
          }),
          "Making a Google Drive folder",
        ),
      );
    },
    async read(file) {
      return bytesOf(
        await call(API + "/" + encodeSegment(file.id) + "?alt=media"),
        "Reading " + file.name + " from Google Drive",
      );
    },
    async write(dir, name, existing, bytes) {
      if (existing) {
        return toItem(
          await json(
            await call(
              UPLOAD +
                "/" +
                encodeSegment(existing.id) +
                "?uploadType=media&fields=" +
                FIELDS,
              {
                method: "PATCH",
                headers: { "content-type": "application/octet-stream" },
                body: bytes,
              },
            ),
            "Saving " + name + " to Google Drive",
          ),
        );
      }
      const boundary = "haxcms" + Math.random().toString(16).slice(2);
      const head = new TextEncoder().encode(
        "--" +
          boundary +
          "\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n" +
          JSON.stringify({ name, parents: [dir.id] }) +
          "\r\n--" +
          boundary +
          "\r\ncontent-type: application/octet-stream\r\n\r\n",
      );
      const tail = new TextEncoder().encode("\r\n--" + boundary + "--");
      return toItem(
        await json(
          await call(UPLOAD + "?uploadType=multipart&fields=" + FIELDS, {
            method: "POST",
            headers: {
              "content-type": "multipart/related; boundary=" + boundary,
            },
            body: new Blob([head, bytes, tail]),
          }),
          "Saving " + name + " to Google Drive",
        ),
      );
    },
    async remove(item) {
      // to Drive's trash, not deleted for good
      await ok(
        await call(API + "/" + encodeSegment(item.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trashed: true }),
        }),
        "Removing " + item.name + " from Google Drive",
      );
    },
  };
}

// ---- OneDrive (scope Files.ReadWrite.AppFolder) --------------------------

function microsoftBackend(call) {
  const DRIVE = "https://graph.microsoft.com/v1.0/me/drive";
  const SELECT = "id,name,folder,file,size,lastModifiedDateTime";
  const toItem = (item) => ({
    id: item.id,
    name: item.name,
    kind: item.folder ? "directory" : "file",
    modified: time(item.lastModifiedDateTime),
    size: Number(item.size) || 0,
  });
  return {
    async root() {
      // Apps/<app name>: the only folder this app can see
      const approot = await json(
        await call(DRIVE + "/special/approot?$select=" + SELECT),
        "Opening the HAXcms folder in OneDrive",
      );
      return toItem(approot);
    },
    async list(dir) {
      const items = [];
      let next =
        DRIVE +
        "/items/" +
        encodeSegment(dir.id) +
        "/children?$top=999&$select=" +
        SELECT;
      while (next) {
        const page = await json(await call(next), "Listing a OneDrive folder");
        for (const item of page.value || []) {
          items.push(toItem(item));
        }
        next =
          typeof page["@odata.nextLink"] === "string" &&
          page["@odata.nextLink"].indexOf(DRIVE + "/") === 0
            ? page["@odata.nextLink"]
            : "";
      }
      return items;
    },
    async mkdir(dir, name) {
      return toItem(
        await json(
          await call(DRIVE + "/items/" + encodeSegment(dir.id) + "/children", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              folder: {},
              "@microsoft.graph.conflictBehavior": "fail",
            }),
          }),
          "Making a OneDrive folder",
        ),
      );
    },
    async read(file) {
      return bytesOf(
        await call(DRIVE + "/items/" + encodeSegment(file.id) + "/content"),
        "Reading " + file.name + " from OneDrive",
      );
    },
    async write(dir, name, existing, bytes) {
      const target = existing
        ? DRIVE + "/items/" + encodeSegment(existing.id) + "/content"
        : DRIVE +
          "/items/" +
          encodeSegment(dir.id) +
          ":/" +
          encodeSegment(name) +
          ":/content";
      return toItem(
        await json(
          await call(target, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
          }),
          "Saving " + name + " to OneDrive",
        ),
      );
    },
    async remove(item) {
      // to the OneDrive recycle bin
      await ok(
        await call(DRIVE + "/items/" + encodeSegment(item.id), {
          method: "DELETE",
        }),
        "Removing " + item.name + " from OneDrive",
      );
    },
  };
}

// ---- Dropbox (App folder access) ------------------------------------------

function dropboxBackend(call) {
  const API = "https://api.dropboxapi.com/2/files";
  const CONTENT = "https://content.dropboxapi.com/2/files";
  const toItem = (entry) => ({
    id: entry.path_lower || entry.path_display,
    path: entry.path_display,
    name: entry.name,
    kind: entry[".tag"] === "folder" ? "directory" : "file",
    modified: time(entry.server_modified),
    size: Number(entry.size) || 0,
  });
  const post = (url, body, what) =>
    call(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => json(response, what));
  return {
    async root() {
      // the app folder (Apps/<app name>) is the root this app sees
      return { id: "", path: "", name: "", kind: "directory" };
    },
    async list(dir) {
      const items = [];
      let page = await post(
        API + "/list_folder",
        { path: dir.path, limit: 2000 },
        "Listing a Dropbox folder",
      );
      for (;;) {
        for (const entry of page.entries || []) {
          if (entry[".tag"] !== "deleted") {
            items.push(toItem(entry));
          }
        }
        if (!page.has_more) {
          break;
        }
        page = await post(
          API + "/list_folder/continue",
          { cursor: page.cursor },
          "Listing a Dropbox folder",
        );
      }
      return items;
    },
    async mkdir(dir, name) {
      const result = await post(
        API + "/create_folder_v2",
        { path: dir.path + "/" + name, autorename: false },
        "Making a Dropbox folder",
      );
      return toItem(Object.assign({ ".tag": "folder" }, result.metadata));
    },
    async read(file) {
      return bytesOf(
        await call(CONTENT + "/download", {
          method: "POST",
          headers: { "dropbox-api-arg": asciiJson({ path: file.path }) },
        }),
        "Reading " + file.name + " from Dropbox",
      );
    },
    async write(dir, name, existing, bytes) {
      const saved = await json(
        await call(CONTENT + "/upload", {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "dropbox-api-arg": asciiJson({
              path: existing ? existing.path : dir.path + "/" + name,
              mode: "overwrite",
              mute: true,
            }),
          },
          body: bytes,
        }),
        "Saving " + name + " to Dropbox",
      );
      return toItem(Object.assign({ ".tag": "file" }, saved));
    },
    async remove(item) {
      // Dropbox keeps deleted files restorable for a while
      await post(
        API + "/delete_v2",
        { path: item.path },
        "Removing " + item.name + " from Dropbox",
      );
    },
  };
}

// ---- Box -------------------------------------------------------------------

function boxBackend(call) {
  const API = "https://api.box.com/2.0";
  const UPLOAD = "https://upload.box.com/api/2.0";
  const toItem = (entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.type === "folder" ? "directory" : "file",
    modified: time(entry.modified_at || entry.content_modified_at),
    size: Number(entry.size) || 0,
  });
  const backend = {
    async root() {
      for (const item of await backend.list({ id: "0" })) {
        if (item.name === FOLDER_NAME && item.kind === "directory") {
          return item;
        }
      }
      return backend.mkdir({ id: "0" }, FOLDER_NAME);
    },
    async list(dir) {
      const items = [];
      let offset = 0;
      for (;;) {
        const page = await json(
          await call(
            API +
              "/folders/" +
              encodeSegment(dir.id) +
              "/items?limit=1000&offset=" +
              offset +
              "&fields=id,type,name,size,modified_at,content_modified_at",
          ),
          "Listing a Box folder",
        );
        for (const entry of page.entries || []) {
          if (entry.type === "file" || entry.type === "folder") {
            items.push(toItem(entry));
          }
        }
        offset += (page.entries || []).length;
        if (
          !page.entries ||
          !page.entries.length ||
          offset >= page.total_count
        ) {
          break;
        }
      }
      return items;
    },
    async mkdir(dir, name) {
      return toItem(
        await json(
          await call(API + "/folders", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, parent: { id: dir.id } }),
          }),
          "Making a Box folder",
        ),
      );
    },
    async read(file) {
      return bytesOf(
        await call(API + "/files/" + encodeSegment(file.id) + "/content"),
        "Reading " + file.name + " from Box",
      );
    },
    async write(dir, name, existing, bytes) {
      const form = new FormData();
      form.append(
        "attributes",
        JSON.stringify(existing ? { name } : { name, parent: { id: dir.id } }),
      );
      form.append("file", new Blob([bytes]), name);
      const saved = await json(
        await call(
          existing
            ? UPLOAD + "/files/" + encodeSegment(existing.id) + "/content"
            : UPLOAD + "/files/content",
          { method: "POST", body: form },
        ),
        "Saving " + name + " to Box",
      );
      return toItem(saved.entries[0]);
    },
    async remove(item) {
      // to the Box trash
      await ok(
        await call(
          API +
            (item.kind === "directory"
              ? "/folders/" + encodeSegment(item.id) + "?recursive=true"
              : "/files/" + encodeSegment(item.id)),
          { method: "DELETE" },
        ),
        "Removing " + item.name + " from Box",
      );
    },
  };
  return backend;
}

// ---- WebDAV (Nextcloud, ownCloud, ...) ------------------------------------

// The parts of a PROPFIND answer this needs, without an XML parser (the
// Worker has no DOMParser): each <response> with its href, whether it is a
// collection, its last-modified date and length. Namespace prefixes vary by
// server, so tags are matched by local name.
function parseMultistatus(xml) {
  const responses = [];
  const tag = (name) =>
    new RegExp(
      "<(?:[\\w-]+:)?" +
        name +
        "\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?" +
        name +
        ">",
      "i",
    );
  const responseTag =
    /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let match;
  while ((match = responseTag.exec(xml))) {
    const body = match[1];
    const href = tag("href").exec(body);
    if (!href) {
      continue;
    }
    const modified = tag("getlastmodified").exec(body);
    const length = tag("getcontentlength").exec(body);
    responses.push({
      href: decodeEntities(href[1].trim()),
      collection: /<(?:[\w-]+:)?collection\b/i.test(body),
      modified: modified ? time(modified[1].trim()) : 0,
      size: length ? Number(length[1].trim()) || 0 : 0,
    });
  }
  return responses;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function basicAuth(username, password) {
  const bytes = new TextEncoder().encode(
    String(username || "") + ":" + String(password || ""),
  );
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return "Basic " + btoa(text);
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function webdavBackend(call, baseUrl) {
  const base = new URL(baseUrl.replace(/\/*$/, "/"));
  const urlOf = (item) => new URL(item.id, base).href;
  return {
    async root() {
      return { id: "", name: "", kind: "directory" };
    },
    async list(dir) {
      const target = new URL(dir.id, base);
      const answer = await ok(
        await call(target.href, {
          method: "PROPFIND",
          headers: {
            depth: "1",
            "content-type": "application/xml; charset=utf-8",
          },
          body:
            '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>' +
            "<d:resourcetype/><d:getlastmodified/><d:getcontentlength/>" +
            "</d:prop></d:propfind>",
        }),
        "Listing a folder on the WebDAV server",
      );
      const items = [];
      for (const entry of parseMultistatus(await answer.text())) {
        const entryUrl = new URL(entry.href, base);
        // only what sits directly in this folder; servers encode paths
        // differently, so compare them decoded
        if (entryUrl.origin !== base.origin) {
          continue;
        }
        const entryPath = safeDecode(entryUrl.pathname);
        const folderPath = safeDecode(target.pathname);
        if (entryPath === null || folderPath === null) {
          continue;
        }
        if (entryPath.indexOf(folderPath) !== 0) {
          continue;
        }
        const relative = entryPath.slice(folderPath.length).replace(/\/$/, "");
        if (!relative || relative.indexOf("/") !== -1) {
          continue;
        }
        items.push({
          id: dir.id + encodeSegment(relative) + (entry.collection ? "/" : ""),
          name: relative,
          kind: entry.collection ? "directory" : "file",
          modified: entry.modified,
          size: entry.size,
        });
      }
      return items;
    },
    async mkdir(dir, name) {
      const id = dir.id + encodeSegment(name) + "/";
      await ok(
        await call(new URL(id, base).href, { method: "MKCOL" }),
        "Making a folder on the WebDAV server",
      );
      return { id, name, kind: "directory", modified: Date.now() };
    },
    async read(file) {
      return bytesOf(
        await call(urlOf(file)),
        "Reading " + file.name + " from the WebDAV server",
      );
    },
    async write(dir, name, existing, bytes) {
      const id = existing ? existing.id : dir.id + encodeSegment(name);
      await ok(
        await call(new URL(id, base).href, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        }),
        "Saving " + name + " to the WebDAV server",
      );
      // WebDAV PUT doesn't say the new date; use now, the next listing
      // corrects it
      return {
        id,
        name,
        kind: "file",
        modified: Date.now(),
        size: bytes.length,
      };
    },
    async remove(item) {
      await ok(
        await call(urlOf(item), { method: "DELETE" }),
        "Removing " + item.name + " from the WebDAV server",
      );
    },
  };
}

// ---- making the root ------------------------------------------------------

// each provider named here: nothing a caller sends picks a function
function backendFor(provider, call) {
  switch (provider) {
    case "google":
      return googleBackend(call);
    case "microsoft":
      return microsoftBackend(call);
    case "dropbox":
      return dropboxBackend(call);
    case "box":
      return boxBackend(call);
    default:
      throw new Error("not a storage provider: " + String(provider));
  }
}

// a WebDAV address: https only (http only for this machine), no credentials
// in it
function validWebdavUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.href;
}

/**
 * The root directory handle for remote storage.
 *
 * @param {object} options
 * @param {string} options.provider  google | microsoft | dropbox | box | webdav
 * @param {function} options.getToken  (force) -> Promise<string|null>: a
 *   current access token from the page (force: renew it first)
 * @param {object} [options.webdav]  { url, username, password }
 * @param {function} [options.fetch]  for tests
 */
async function createRemoteRoot(options) {
  const doFetch = options.fetch || globalThis.fetch.bind(globalThis);
  let call;
  let backend;
  if (options.provider === "webdav") {
    const webdav = options.webdav || {};
    const url = validWebdavUrl(webdav.url);
    if (!url) {
      throw new Error("That WebDAV address can't be used (it must be https)");
    }
    const auth = basicAuth(webdav.username, webdav.password);
    call = (target, init) =>
      doFetch(
        target,
        Object.assign({}, init || {}, {
          headers: Object.assign({}, (init && init.headers) || {}, {
            authorization: auth,
          }),
        }),
      );
    backend = webdavBackend(call, url);
  } else if (
    options.provider === "google" ||
    options.provider === "microsoft" ||
    options.provider === "dropbox" ||
    options.provider === "box"
  ) {
    let current = await options.getToken(false);
    if (!current) {
      throw new Error("Sign in to " + options.provider + " first");
    }
    const send = (target, init, token) =>
      doFetch(
        target,
        Object.assign({}, init || {}, {
          headers: Object.assign({}, (init && init.headers) || {}, {
            authorization: "Bearer " + token,
          }),
        }),
      );
    call = async (target, init) => {
      let response = await send(target, init, current);
      if (response.status === 401) {
        const renewed = await options.getToken(true);
        if (!renewed) {
          return response;
        }
        current = renewed;
        response = await send(target, init, current);
      }
      return response;
    };
    backend = backendFor(options.provider, call);
  } else {
    throw new Error("not a storage provider: " + String(options.provider));
  }
  const rootItem = await backend.root();
  return new RemoteDirectory(
    backend,
    Object.assign({ name: "" }, rootItem),
    new Map(),
  );
}

module.exports = {
  createRemoteRoot,
  RemoteDirectory,
  RemoteFile,
  parseMultistatus,
  asciiJson,
  validWebdavUrl,
  FOLDER_NAME,
  // the backends, for tests
  backends: {
    google: googleBackend,
    microsoft: microsoftBackend,
    dropbox: dropboxBackend,
    box: boxBackend,
    webdav: webdavBackend,
  },
};
