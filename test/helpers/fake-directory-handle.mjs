// An in-memory stand-in for FileSystemDirectoryHandle (the File System Access
// API), with the parts DirectoryStorage uses and a way to make writes fail.
// Like the real thing, createWritable() only replaces the file on close().
let clock = 1000;

function notFound(name) {
  const error = new Error("not found: " + name);
  error.name = "NotFoundError";
  return error;
}

export class FakeFileHandle {
  constructor(name, root) {
    this.kind = "file";
    this.name = name;
    this.root = root;
    this.bytes = new Uint8Array(0);
    this.lastModified = ++clock;
  }
  async getFile() {
    const bytes = this.bytes;
    return {
      lastModified: this.lastModified,
      size: bytes.length,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  async createWritable() {
    const file = this;
    let pending = null;
    return {
      async write(data) {
        if (file.root.failWrites.has(file.name)) {
          throw new Error("disk full (injected)");
        }
        pending = new Uint8Array(data);
      },
      async close() {
        if (file.root.failCloses.has(file.name)) {
          throw new Error("could not finish the write (injected)");
        }
        file.bytes = pending || new Uint8Array(0);
        file.lastModified = ++clock;
        file.root.writes.push(file.name);
      },
      async abort() {
        pending = null;
      },
    };
  }
  // what another program does: change the file behind our back
  externalWrite(text) {
    this.bytes = new TextEncoder().encode(text);
    this.lastModified = ++clock;
  }
}

export class FakeDirectoryHandle {
  constructor(name = "", root = null) {
    this.kind = "directory";
    this.name = name;
    this.children = new Map();
    this.root = root || this;
    if (!root) {
      this.failWrites = new Set();
      this.failCloses = new Set();
      this.writes = [];
    }
  }
  async *entries() {
    for (const entry of Array.from(this.children)) {
      yield entry;
    }
  }
  async getDirectoryHandle(name, options = {}) {
    let child = this.children.get(name);
    if (!child) {
      if (!options.create) {
        throw notFound(name);
      }
      child = new FakeDirectoryHandle(name, this.root);
      this.children.set(name, child);
    }
    if (child.kind !== "directory") {
      throw new TypeError(name + " is a file");
    }
    return child;
  }
  async getFileHandle(name, options = {}) {
    let child = this.children.get(name);
    if (!child) {
      if (!options.create) {
        throw notFound(name);
      }
      child = new FakeFileHandle(name, this.root);
      this.children.set(name, child);
    }
    if (child.kind !== "file") {
      throw new TypeError(name + " is a folder");
    }
    return child;
  }
  async removeEntry(name, options = {}) {
    const child = this.children.get(name);
    if (!child) {
      throw notFound(name);
    }
    if (
      child.kind === "directory" &&
      child.children.size &&
      !options.recursive
    ) {
      throw new Error(name + " is not empty");
    }
    this.children.delete(name);
  }
  // { "a/b.txt": "text" } of everything below this folder
  tree(prefix = "") {
    const out = {};
    for (const [name, child] of this.children) {
      const relative = prefix ? prefix + "/" + name : name;
      if (child.kind === "directory") {
        out[relative + "/"] = null;
        Object.assign(out, child.tree(relative));
      } else {
        out[relative] = new TextDecoder().decode(child.bytes);
      }
    }
    return out;
  }
}
