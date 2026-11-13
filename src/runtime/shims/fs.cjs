// fs for the browser runtime: one in-memory volume (memfs, Apache-2.0) shared
// by everything in the Worker. haxcms-nodejs makes many synchronous fs calls,
// so the volume answers them from memory; storage adapters (a folder on the
// user's computer, browser storage) load into it and persist out of it.
const { fs, vol } = require("memfs");

fs.__volume = vol;
module.exports = fs;
