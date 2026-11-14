/**
 * Finishing a sign-in: trading an authorization code (or a refresh token)
 * for tokens at the provider, with the client secret only this deployment
 * knows (haxtheweb/issues#3341). See providers.js for the providers and
 * broker.js for the rules every broker route keeps.
 *
 * The broker keeps nothing: the tokens go straight back to the page that
 * asked, which keeps them in the tab (memory, and a refresh token in
 * sessionStorage).
 */
const crypto = require("node:crypto");

// the fields a page gets back; anything else a provider sends is dropped
const TOKEN_FIELDS = [
  "access_token",
  "refresh_token",
  "expires_in",
  "token_type",
  "scope",
  "id_token",
  // Vercel: the team the integration was installed to, if any
  "team_id",
  "user_id",
];

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Apple's client secret: a token signed with the key Apple issued for this
 * app (ES256), valid for five minutes. Apple has no fixed secret.
 */
function appleClientSecret(spec) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: spec.extra.KEY_ID };
  const claims = {
    iss: spec.extra.TEAM_ID,
    iat: now,
    exp: now + 300,
    aud: "https://appleid.apple.com",
    sub: spec.clientId,
  };
  const unsigned =
    base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
  // keys pasted into an environment variable often have their line breaks
  // written as \n
  const pem = spec.extra.PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = crypto.sign("sha256", Buffer.from(unsigned), {
    key: pem,
    dsaEncoding: "ieee-p1363",
  });
  return unsigned + "." + base64url(signature);
}

function clientSecret(spec) {
  return spec.id === "apple" ? appleClientSecret(spec) : spec.clientSecret;
}

/**
 * POST the grant to the provider's token endpoint. Returns
 * { status, tokens } where tokens holds only TOKEN_FIELDS, or
 * { status, error } with a message safe to show.
 */
async function requestTokens(spec, grant) {
  const form = new URLSearchParams();
  for (const key of Object.keys(grant)) {
    if (grant[key] !== undefined && grant[key] !== null && grant[key] !== "") {
      form.set(key, String(grant[key]));
    }
  }
  form.set("client_id", spec.clientId);
  form.set("client_secret", clientSecret(spec));
  let response;
  try {
    // spec.tokenUrl is a fixed address from providers.js
    response = await fetch(spec.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    });
  } catch (e) {
    return { status: 502, error: spec.label + " could not be reached" };
  }
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  // GitHub answers 200 with an "error" field for a bad code
  if (!response.ok || !body || typeof body.access_token !== "string") {
    const reason =
      body && typeof body.error === "string"
        ? body.error.replace(/[^\w .-]/g, "").slice(0, 80)
        : String(response.status);
    return {
      status: response.status === 401 || response.status === 400 ? 401 : 502,
      error: spec.label + " did not finish the sign-in (" + reason + ")",
    };
  }
  const tokens = {};
  for (const field of TOKEN_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      tokens[field] =
        typeof body[field] === "number" ? body[field] : String(body[field]);
    }
  }
  return { status: 200, tokens };
}

// the claims of a JWT we received straight from the provider over TLS (not
// from the page), so they are read without checking the signature
function jwtClaims(token) {
  if (typeof token !== "string") {
    return {};
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }
  try {
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? claims : {};
  } catch (e) {
    return {};
  }
}

module.exports = { requestTokens, jwtClaims, appleClientSecret };
