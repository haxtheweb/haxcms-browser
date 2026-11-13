// crypto for the browser runtime: crypto-browserify (via @jspm/core) for
// hashes/HMAC, Web Crypto for randomness, and scrypt from scrypt-js (MIT).
// scrypt takes the same parameters and returns the same bytes as Node's, so
// a password hash made here verifies on a server and the other way around.
const jspmCrypto = require("jspm:crypto");
const scryptJs = require("scrypt-js");

const crypto = Object.assign({}, jspmCrypto.default || jspmCrypto);

function toBuffer(value) {
  return typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.from(value);
}
function scryptParams(options) {
  const o = options || {};
  return {
    N: o.N || o.cost || 16384,
    r: o.r || o.blockSize || 8,
    p: o.p || o.parallelization || 1,
  };
}

crypto.webcrypto = globalThis.crypto;
crypto.randomUUID = () => globalThis.crypto.randomUUID();
crypto.getRandomValues = (array) => globalThis.crypto.getRandomValues(array);
crypto.scryptSync = (password, salt, keylen, options) => {
  const { N, r, p } = scryptParams(options);
  return Buffer.from(
    scryptJs.syncScrypt(toBuffer(password), toBuffer(salt), N, r, p, keylen),
  );
};
crypto.scrypt = (password, salt, keylen, options, callback) => {
  let opts = options;
  let cb = callback;
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  const { N, r, p } = scryptParams(opts);
  scryptJs.scrypt(toBuffer(password), toBuffer(salt), N, r, p, keylen).then(
    (key) => cb(null, Buffer.from(key)),
    (err) => cb(err),
  );
};
if (!crypto.timingSafeEqual) {
  crypto.timingSafeEqual = (a, b) => {
    if (a.length !== b.length) {
      throw new RangeError("Input buffers must have the same byte length");
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  };
}

module.exports = crypto;
