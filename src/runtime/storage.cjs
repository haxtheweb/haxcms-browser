/**
 * Keeps a folder of the in-memory volume and a directory handle the same
 * (haxtheweb/issues#3331).
 *
 * haxcms-nodejs works on an in-memory volume because its file calls are
 * synchronous. This is what makes that volume durable: the sites folder is
 * loaded from a FileSystemDirectoryHandle on start and written back after
 * every change. The handle is either a folder the user picked on their
 * computer or the browser's own private file system; both are the same API.
 *
 *   load()     handle -> volume, on start
 *   flush()    volume -> handle: everything that changed since the last sync
 *   refresh()  handle -> volume: files changed by something else (the user
 *              edited the folder in another program)
 *
 * Rules this file keeps:
 * - flush() either writes everything that changed or throws. What it could
 *   not write stays marked as changed, so the next flush tries again.
 * - A file is replaced through createWritable(), which only swaps the file
 *   in when the whole write has succeeded: a failed write leaves the old
 *   file as it was.
 * - Only regular files and folders are mirrored. Symbolic links stay in the
 *   volume (a directory handle cannot hold them, and the ones haxcms-nodejs
 *   makes inside a site point at its shared front-end build).
 * - Nothing outside `root` in the volume, and nothing outside the handle, is
 *   ever read, written or removed.
 */

// never mirrored in either direction
const SKIP = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

class DirectoryStorage {
  /**
   * @param {object} options
   * @param {object} options.fs      the volume's fs (sync API)
   * @param {object} options.path    posix path module
   * @param {object} options.handle  FileSystemDirectoryHandle to mirror to
   * @param {string} options.root    folder in the volume to mirror
   */
  constructor({ fs, path, handle, root }) {
    this.fs = fs;
    this.path = path;
    this.handle = handle;
    this.root = root;
    // relative path -> { size, mtimeMs (in the volume), disk (lastModified on the handle) }
    this.files = new Map();
    // relative paths of the folders both sides have
    this.folders = new Set();
  }

  // ---- handle helpers ---------------------------------------------------

  async directoryFor(relativeDir, create) {
    let dir = this.handle;
    if (relativeDir === "" || relativeDir === ".") {
      return dir;
    }
    for (const part of relativeDir.split("/")) {
      dir = await dir.getDirectoryHandle(part, { create: !!create });
    }
    return dir;
  }

  async writeFile(relativeFile, bytes) {
    const dir = await this.directoryFor(this.path.dirname(relativeFile), true);
    const file = await dir.getFileHandle(this.path.basename(relativeFile), {
      create: true,
    });
    if (typeof file.createWritable === "function") {
      const writable = await file.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (e) {
        if (typeof writable.abort === "function") {
          await writable.abort().catch(() => {});
        }
        throw e;
      }
    } else {
      // browsers whose private file system only has the synchronous handle
      const access = await file.createSyncAccessHandle();
      try {
        access.truncate(0);
        access.write(bytes, { at: 0 });
        access.flush();
      } finally {
        access.close();
      }
    }
    return (await file.getFile()).lastModified;
  }

  async walkHandle(dir, prefix, visit) {
    for await (const [name, entry] of dir.entries()) {
      if (SKIP.has(name)) {
        continue;
      }
      const relative = prefix ? prefix + "/" + name : name;
      if (entry.kind === "directory") {
        await visit(relative, entry, true);
        await this.walkHandle(entry, relative, visit);
      } else {
        await visit(relative, entry, false);
      }
    }
  }

  // ---- volume helpers ---------------------------------------------------

  walkVolume(visit) {
    const walk = (relativeDir) => {
      const absoluteDir = relativeDir
        ? this.path.join(this.root, relativeDir)
        : this.root;
      for (const name of this.fs.readdirSync(absoluteDir)) {
        if (SKIP.has(name)) {
          continue;
        }
        const relative = relativeDir ? relativeDir + "/" + name : name;
        const stat = this.fs.lstatSync(this.path.join(this.root, relative));
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          visit(relative, stat, true);
          walk(relative);
        } else if (stat.isFile()) {
          visit(relative, stat, false);
        }
      }
    };
    if (this.fs.existsSync(this.root)) {
      walk("");
    }
  }

  putInVolume(relative, bytes) {
    const absolute = this.path.join(this.root, relative);
    this.fs.mkdirSync(this.path.dirname(absolute), { recursive: true });
    this.fs.writeFileSync(absolute, bytes);
    return this.fs.statSync(absolute);
  }

  // ---- the three operations ---------------------------------------------

  /** handle -> volume. Returns { files, bytes }. */
  async load() {
    this.files.clear();
    this.folders.clear();
    this.fs.mkdirSync(this.root, { recursive: true });
    let bytes = 0;
    await this.walkHandle(this.handle, "", async (relative, entry, isDir) => {
      if (isDir) {
        this.fs.mkdirSync(this.path.join(this.root, relative), {
          recursive: true,
        });
        this.folders.add(relative);
        return;
      }
      const file = await entry.getFile();
      const data = new Uint8Array(await file.arrayBuffer());
      const stat = this.putInVolume(relative, data);
      bytes += data.length;
      this.files.set(relative, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        disk: file.lastModified,
      });
    });
    return { files: this.files.size, bytes };
  }

  /** volume -> handle. Returns { written, removed }; throws if any write failed. */
  async flush() {
    const seenFiles = new Set();
    const seenFolders = new Set();
    const changed = [];
    this.walkVolume((relative, stat, isDir) => {
      if (isDir) {
        seenFolders.add(relative);
        return;
      }
      seenFiles.add(relative);
      const known = this.files.get(relative);
      if (
        !known ||
        known.size !== stat.size ||
        known.mtimeMs !== stat.mtimeMs
      ) {
        changed.push({ relative, stat });
      }
    });
    const failures = [];
    let written = 0;
    let removed = 0;
    // folders first, so an empty new folder exists on the handle too
    for (const relative of seenFolders) {
      if (!this.folders.has(relative)) {
        try {
          await this.directoryFor(relative, true);
          this.folders.add(relative);
        } catch (e) {
          failures.push({ path: relative, error: e });
        }
      }
    }
    for (const { relative, stat } of changed) {
      try {
        const bytes = this.fs.readFileSync(this.path.join(this.root, relative));
        const disk = await this.writeFile(relative, bytes);
        this.files.set(relative, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          disk,
        });
        written += 1;
      } catch (e) {
        failures.push({ path: relative, error: e });
      }
    }
    // what the volume no longer has: files, then folders deepest first
    for (const relative of Array.from(this.files.keys())) {
      if (seenFiles.has(relative)) {
        continue;
      }
      try {
        const dir = await this.directoryFor(
          this.path.dirname(relative),
          false,
        ).catch(() => null);
        if (dir) {
          await dir
            .removeEntry(this.path.basename(relative))
            .catch(ignoreNotFound);
        }
        this.files.delete(relative);
        removed += 1;
      } catch (e) {
        failures.push({ path: relative, error: e });
      }
    }
    const goneFolders = Array.from(this.folders)
      .filter((relative) => !seenFolders.has(relative))
      .sort((a, b) => b.length - a.length);
    for (const relative of goneFolders) {
      try {
        const dir = await this.directoryFor(
          this.path.dirname(relative),
          false,
        ).catch(() => null);
        if (dir) {
          await dir
            .removeEntry(this.path.basename(relative), { recursive: true })
            .catch(ignoreNotFound);
        }
        this.folders.delete(relative);
      } catch (e) {
        failures.push({ path: relative, error: e });
      }
    }
    if (failures.length) {
      const first = failures[0];
      const error = new Error(
        "could not save " +
          failures.length +
          " file(s), first: " +
          first.path +
          " (" +
          String((first.error && first.error.message) || first.error) +
          ")",
      );
      error.failures = failures.map((failure) => failure.path);
      throw error;
    }
    return { written, removed };
  }

  /**
   * handle -> volume, for what changed on the handle since the last sync.
   * Call it only when the volume has nothing unsaved (right after a flush).
   * Returns { updated, removed }.
   */
  async refresh() {
    const seenFiles = new Set();
    const seenFolders = new Set();
    let updated = 0;
    let removed = 0;
    await this.walkHandle(this.handle, "", async (relative, entry, isDir) => {
      if (isDir) {
        seenFolders.add(relative);
        if (!this.folders.has(relative)) {
          this.fs.mkdirSync(this.path.join(this.root, relative), {
            recursive: true,
          });
          this.folders.add(relative);
        }
        return;
      }
      seenFiles.add(relative);
      const file = await entry.getFile();
      const known = this.files.get(relative);
      if (
        known &&
        known.disk === file.lastModified &&
        known.size === file.size
      ) {
        return;
      }
      const stat = this.putInVolume(
        relative,
        new Uint8Array(await file.arrayBuffer()),
      );
      this.files.set(relative, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        disk: file.lastModified,
      });
      updated += 1;
    });
    for (const relative of Array.from(this.files.keys())) {
      if (!seenFiles.has(relative)) {
        this.fs.rmSync(this.path.join(this.root, relative), { force: true });
        this.files.delete(relative);
        removed += 1;
      }
    }
    const goneFolders = Array.from(this.folders)
      .filter((relative) => !seenFolders.has(relative))
      .sort((a, b) => b.length - a.length);
    for (const relative of goneFolders) {
      this.fs.rmSync(this.path.join(this.root, relative), {
        recursive: true,
        force: true,
      });
      this.folders.delete(relative);
    }
    return { updated, removed };
  }
}

function ignoreNotFound(error) {
  if (error && error.name === "NotFoundError") {
    return;
  }
  throw error;
}

module.exports = { DirectoryStorage };
