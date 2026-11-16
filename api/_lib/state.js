/**
 * Keeping a sign-in's state between /api/oauth/start and
 * /api/oauth/callback without storing anything (haxtheweb/issues#3341).
 *
 * start puts what the callback needs (provider, state, PKCE verifier, the
 * page's nonce and key) in a cookie signed with HAX_OAUTH_STATE_SECRET.
 * The cookie is HttpOnly, only sent to /api/oauth, lasts ten minutes and is
 * named after the state, so the provider's answer only finishes the sign-in
 * this browser started. The callback clears it.
 *
 * The result goes back to the page sealed with the key the page made for
 * this one sign-in (AES-256-GCM), so only the page that started the sign-in
 * can read the tokens, even though the result is passed on through the
 * popup's address fragment and a BroadcastChannel.
 *
 * Rules this file keeps:
 * - Sign-in is off when HAX_OAUTH_STATE_SECRET is not set (or is short).
 * - A cookie is trusted only when its signature checks out, compared in
 *   constant time, and it is younger than MAX_AGE_S.
 */
const crypto = require("node:crypto");

const MAX_AGE_S = 600;
const COOKIE_PREFIX = "hax_oauth_";

function secret() {
  const value = String(process.env.HAX_OAUTH_STATE_SECRET || "").trim();
  return value.length >= 32 ? value : "";
}

function sign(text) {
  return crypto.createHmac("sha256", secret()).update(text).digest("base64url");
}

// payload -> "<base64url json>.<signature>"
function seal(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return body + "." + sign(body);
}

// the payload of a cookie seal() made, or null
function unseal(value) {
  if (!secret() || typeof value !== "string" || value.length > 4096) {
    return null;
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const expected = Buffer.from(sign(parts[0]));
  const given = Buffer.from(parts[1]);
  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(expected, given)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.t !== "number" ||
      Date.now() - payload.t > MAX_AGE_S * 1000 ||
      Date.now() < payload.t - 60 * 1000
    ) {
      return null;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function cookieName(state) {
  return COOKIE_PREFIX + state;
}

// https deployments: Secure and SameSite=None, because Apple returns with a
// cross-site form post. Plain http (local tests): Lax, without Secure.
function setCookie(res, name, value, maxAge, secure) {
  res.setHeader(
    "set-cookie",
    name +
      "=" +
      value +
      "; Path=/api/oauth; Max-Age=" +
      maxAge +
      "; HttpOnly; " +
      (secure ? "Secure; SameSite=None" : "SameSite=Lax"),
  );
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

// seal `value` for the page with its 32-byte key (base64url):
// base64url(iv | ciphertext | tag), what WebCrypto's AES-GCM decrypt takes
function encryptFor(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, data, cipher.getAuthTag()]).toString("base64url");
}

// send the popup on to /api/oauth/done with `params` in the address
// fragment, which browsers never send to a server
function toDone(res, params) {
  res.statusCode = 303;
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "location",
    "/api/oauth/done#" + new URLSearchParams(params).toString(),
  );
  res.end();
}

module.exports = {
  toDone,
  MAX_AGE_S,
  secret,
  seal,
  unseal,
  cookieName,
  setCookie,
  readCookie,
  encryptFor,
};
