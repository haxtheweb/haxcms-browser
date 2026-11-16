/**
 * GET /api/oauth/start?provider=<id>&nonce=<nonce>&key=<key>
 *
 * Where the page's sign-in popup opens (haxtheweb/issues#3341). Makes the
 * state and PKCE verifier, keeps them with the page's nonce and key in a
 * signed cookie (api/_lib/state.js), and sends the person to the provider
 * with /api/oauth/callback as the return address. The same return address
 * is used for every provider, Apple included.
 *
 * nonce: how the page recognizes its own result. key: 32 random bytes the
 * page made for this sign-in; the result comes back sealed with it.
 */
const crypto = require("node:crypto");
const { ownOrigin, refuse } = require("../_lib/broker.js");
const { provider } = require("../_lib/providers.js");
const {
  MAX_AGE_S,
  cookieName,
  seal,
  setCookie,
  toDone,
} = require("../_lib/state.js");

module.exports = function oauthStart(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    refuse(res, 405, "Method not allowed");
    return;
  }
  const query = new URL(req.url, "http://localhost").searchParams;
  const nonce = query.get("nonce") || "";
  const key = query.get("key") || "";
  const home = ownOrigin(req);
  if (
    !home ||
    !/^[\w-]{16,64}$/.test(nonce) ||
    !/^[\w-]{43}$/.test(key) ||
    Buffer.from(key, "base64url").length !== 32
  ) {
    toDone(res, { e: "That sign-in could not be started. Try again." });
    return;
  }
  const spec = provider(query.get("provider"));
  if (!spec) {
    toDone(res, { n: nonce, e: "That sign-in is not set up here." });
    return;
  }
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  let authorize;
  if (spec.id === "vercel") {
    // a Vercel Integration's install page knows its own client and return
    // address (set to /api/oauth/callback in the integration's settings)
    authorize = new URL(
      "https://vercel.com/integrations/" +
        encodeURIComponent(spec.extra.INTEGRATION) +
        "/new",
    );
  } else {
    // spec.authorizeUrl is a fixed address from providers.js
    authorize = new URL(spec.authorizeUrl);
    authorize.searchParams.set("client_id", spec.clientId);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("redirect_uri", home + "/api/oauth/callback");
    if (spec.scopes.length) {
      authorize.searchParams.set("scope", spec.scopes.join(" "));
    }
    if (spec.pkce) {
      authorize.searchParams.set(
        "code_challenge",
        crypto.createHash("sha256").update(verifier).digest("base64url"),
      );
      authorize.searchParams.set("code_challenge_method", "S256");
    }
    if (spec.id === "apple") {
      // Apple only sends the name and email back as a form post
      authorize.searchParams.set("response_mode", "form_post");
    }
    for (const name of Object.keys(spec.params || {})) {
      authorize.searchParams.set(name, spec.params[name]);
    }
  }
  authorize.searchParams.set("state", state);
  setCookie(
    res,
    cookieName(state),
    seal({
      p: spec.id,
      s: state,
      v: verifier,
      n: nonce,
      k: key,
      t: Date.now(),
    }),
    MAX_AGE_S,
    home.startsWith("https://"),
  );
  res.statusCode = 302;
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("location", authorize.href);
  res.end();
};
