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
// randomInt([min,] max[, callback]): uniform in [min, max), by rejection
// sampling over 48 random bits like Node's
crypto.randomInt = (a, b, c) => {
  let min = 0;
  let max = a;
  let callback = b;
  if (typeof b === "number") {
    min = a;
    max = b;
    callback = c;
  }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min) {
    throw new RangeError("randomInt: need safe integers with min < max");
  }
  const range = max - min;
  const limit = 2 ** 48 - (2 ** 48 % range);
  let value;
  const words = new Uint16Array(3);
  do {
    globalThis.crypto.getRandomValues(words);
    value = words[0] * 2 ** 32 + words[1] * 2 ** 16 + words[2];
  } while (value >= limit);
  const result = min + (value % range);
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, result));
    return undefined;
  }
  return result;
};
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
// KeyObject for secret (HMAC) keys, which is what HAXcms signs its JWTs
// with. jsonwebtoken wraps secrets in a KeyObject and jwa hands that to
// createHmac. Asymmetric keys (createPrivateKey / createPublicKey) are not
// supported; jsonwebtoken falls back to createSecretKey when they throw.
class KeyObject {
  constructor(type, data) {
    this.type = type;
    this._data = data;
    this.symmetricKeySize = data.length;
  }
  export() {
    return Buffer.from(this._data);
  }
  equals(other) {
    return (
      other instanceof KeyObject &&
      other.type === this.type &&
      Buffer.compare(other._data, this._data) === 0
    );
  }
}
crypto.KeyObject = KeyObject;
crypto.createSecretKey = (key, encoding) =>
  new KeyObject(
    "secret",
    typeof key === "string" ? Buffer.from(key, encoding) : Buffer.from(key),
  );
crypto.createPrivateKey = () => {
  throw new Error("asymmetric keys are not available in the browser runtime");
};
crypto.createPublicKey = crypto.createPrivateKey;
const createHmac = crypto.createHmac;
crypto.createHmac = (algorithm, key, options) =>
  createHmac(algorithm, key instanceof KeyObject ? key.export() : key, options);

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
