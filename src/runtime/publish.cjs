/**
 * Packs a site for a static host (haxtheweb/issues#3341).
 *
 * What goes in follows the HAX CLI's static publish (`hax site site:surge`,
 * prepareSiteForStaticPublish in haxtheweb/create) so a site published from
 * the browser is the same as one published from a terminal:
 *
 * - ghpages.html is served as index.html (it finds its base and the
 *   front-end build without a HAXcms server); ghpages.html stays as well
 * - left out: what only exists for a local HAXcms (the top-level build/
 *   folder and wc-registry.json, assets/babel*), node_modules, dist, logs,
 *   *.log, and every dotfile or dot folder
 * - only regular files are packed; symbolic links (the ones haxcms-nodejs
 *   makes inside a site point at its shared front-end build) are skipped
 *
 * - llms-full.txt (the whole site as one markdown document for AI agents,
 *   haxtheweb/issues#3104): a static host has no server to answer it, so the
 *   pack carries the answer the in-browser HAXcms gives for it (the
 *   anonymous view; private sites have none). A llms-full.txt the site
 *   already has is kept as it is, like the CLI does
 *
 * Nothing in the site is changed: the index.html swap and llms-full.txt
 * happen in the packed copy only.
 *
 * The pack is a gzipped tarball whose entries sit under "./", the layout
 * `tar czf - -C <site> .` makes and the Surge deploy API expects.
 */

const TOP_LEVEL_SKIP = new Set(["build", "wc-registry.json"]);
const ANYWHERE_SKIP = new Set(["node_modules", "dist", "logs"]);
const ASSETS_SKIP_PREFIX = "babel";

// a site is one folder directly in the sites folder; its name is never a path
function validSiteName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) &&
    name.indexOf("..") === -1
  );
}

function skipped(relative) {
  const parts = relative.split("/");
  const name = parts[parts.length - 1];
  if (parts.some((part) => part.charAt(0) === ".")) {
    return true;
  }
  if (parts.some((part) => ANYWHERE_SKIP.has(part))) {
    return true;
  }
  if (/\.log$/i.test(name)) {
    return true;
  }
  if (parts.length === 1 && TOP_LEVEL_SKIP.has(name)) {
    return true;
  }
  if (
    parts.length === 2 &&
    parts[0] === "assets" &&
    name.startsWith(ASSETS_SKIP_PREFIX)
  ) {
    return true;
  }
  return false;
}

/**
 * The files a static host gets for one site, as [{ path, bytes }] with paths
 * relative to the site folder, sorted.
 */
function collectSiteFiles(fs, path, siteDir) {
  const files = [];
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const relative = prefix ? prefix + "/" + entry : entry;
      if (skipped(relative)) {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        walk(full, relative);
      } else if (stat.isFile()) {
        files.push({ path: relative, bytes: fs.readFileSync(full) });
      }
    }
  }
  walk(siteDir, "");
  const ghpages = files.find((file) => file.path === "ghpages.html");
  if (ghpages) {
    const index = files.find((file) => file.path === "index.html");
    if (index) {
      index.bytes = ghpages.bytes;
    } else {
      files.push({ path: "index.html", bytes: ghpages.bytes });
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
  }
  return files;
}

// ---- tar (POSIX ustar) ----------------------------------------------------

const encoder = new TextEncoder();

function writeString(block, offset, length, value) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) {
    throw new Error("tar field too long: " + value);
  }
  block.set(bytes, offset);
}

function writeOctal(block, offset, length, value) {
  // length - 1 digits, then NUL
  const digits = Math.floor(value)
    .toString(8)
    .padStart(length - 1, "0");
  if (digits.length > length - 1) {
    throw new Error("tar number too large: " + value);
  }
  writeString(block, offset, length - 1, digits);
}

// ustar keeps names up to 100 bytes, or 255 split as prefix (155) / name (100)
function splitName(name) {
  const bytes = encoder.encode(name);
  if (bytes.length <= 100) {
    return { prefix: "", name };
  }
  for (let i = name.length - 1; i > 0; i--) {
    if (name.charAt(i) !== "/") {
      continue;
    }
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (
      encoder.encode(prefix).length <= 155 &&
      encoder.encode(rest).length <= 100 &&
      rest.length > 0
    ) {
      return { prefix, name: rest };
    }
  }
  throw new Error("path too long to publish: " + name);
}

function header(name, size, type, mtime) {
  const block = new Uint8Array(512);
  const split = splitName(name);
  writeString(block, 0, 100, split.name);
  writeOctal(block, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime);
  // checksum is computed with its own field as spaces
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  writeString(block, 345, 155, split.prefix);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += block[i];
  }
  writeString(block, 148, 7, sum.toString(8).padStart(6, "0") + "\0");
  return block;
}

/**
 * A tar archive (uncompressed) of files [{ path, bytes }], every entry under
 * "./" with its folders listed before it.
 */
function tar(files, mtimeSeconds) {
  const mtime =
    typeof mtimeSeconds === "number"
      ? mtimeSeconds
      : Math.floor(Date.now() / 1000);
  const chunks = [header("./", 0, "5", mtime)];
  const folders = new Set();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!folders.has(folder)) {
        folders.add(folder);
        chunks.push(header("./" + folder + "/", 0, "5", mtime));
      }
    }
    const bytes =
      file.bytes instanceof Uint8Array
        ? file.bytes
        : new Uint8Array(file.bytes);
    chunks.push(header("./" + file.path, bytes.length, "0", mtime));
    chunks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) {
      chunks.push(new Uint8Array(padding));
    }
  }
  // end of archive: two empty blocks
  chunks.push(new Uint8Array(1024));
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function gzip(bytes) {
  if (typeof CompressionStream !== "function") {
    throw new Error("this browser cannot compress files (CompressionStream)");
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files a static host gets for one site, [{ path, bytes }] sorted: the
 * site's files (collectSiteFiles) plus extras ([{ path, bytes }],
 * generated files), each extra only where the site has no file of that
 * name.
 */
function publishFiles(fs, path, siteDir, extras) {
  const files = collectSiteFiles(fs, path, siteDir);
  for (const extra of extras || []) {
    if (!files.some((file) => file.path === extra.path)) {
      files.push(extra);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * Pack one site folder for a static host: { files, bytes, body } where body
 * is the gzipped tarball as an ArrayBuffer.
 */
async function packSite(fs, path, siteDir, extras) {
  const files = publishFiles(fs, path, siteDir, extras);
  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("this site has no index.html to publish");
  }
  const archive = tar(files);
  const packed = await gzip(archive);
  return {
    files: files.length,
    bytes: archive.length,
    body: packed.buffer.slice(
      packed.byteOffset,
      packed.byteOffset + packed.byteLength,
    ),
  };
}

/**
 * The sites in the sites folder that can be published:
 * [{ name, title, domain }] where domain is what the site's CNAME holds
 * (where it was published before), if anything.
 */
function listSites(fs, path, sitesDir) {
  const sites = [];
  if (!fs.existsSync(sitesDir)) {
    return sites;
  }
  for (const name of fs.readdirSync(sitesDir).sort()) {
    if (!validSiteName(name)) {
      continue;
    }
    const dir = path.join(sitesDir, name);
    const manifest = path.join(dir, "site.json");
    if (!fs.lstatSync(dir).isDirectory() || !fs.existsSync(manifest)) {
      continue;
    }
    let title = name;
    try {
      const site = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (site && typeof site.title === "string" && site.title.trim()) {
        title = site.title.trim();
      }
    } catch {
      // an unreadable site.json still lists the folder by name
    }
    let domain = "";
    const cname = path.join(dir, "CNAME");
    if (fs.existsSync(cname)) {
      domain = String(fs.readFileSync(cname, "utf8")).trim();
    }
    sites.push({ name, title, domain });
  }
  return sites;
}

module.exports = {
  validSiteName,
  collectSiteFiles,
  publishFiles,
  tar,
  gzip,
  packSite,
  listSites,
};
