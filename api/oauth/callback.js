/**
 * GET or POST /api/oauth/callback: where every provider sends the person
 * back (haxtheweb/issues#3341). Apple posts a form; the rest come back with
 * the code in the query.
 *
 * Finishes the sign-in only when the state matches a cookie this browser
 * got from /api/oauth/start (api/_lib/state.js), then trades the code for
 * tokens with this deployment's client secret and the PKCE verifier from
 * the cookie. The result is sealed with the page's key and sent on to
 * /api/oauth/done in the address fragment. Nothing is kept.
 *
 * Apple is used for sign-in only: the page gets the name and email, no
 * token.
 */
const { ownOrigin, readBody, refuse } = require("../_lib/broker.js");
const { provider } = require("../_lib/providers.js");
const { requestTokens, jwtClaims } = require("../_lib/oauth.js");
const {
  cookieName,
  encryptFor,
  readCookie,
  setCookie,
  toDone,
  unseal,
} = require("../_lib/state.js");

function clean(value, max) {
  return String(value || "")
    .split("")
    .filter((char) => char.charCodeAt(0) >= 32 && !"<>\"'`".includes(char))
    .join("")
    .trim()
    .slice(0, max);
}

function appleName(form) {
  // the name only comes the first time someone signs in to this app
  try {
    const user = JSON.parse(form.get("user") || "{}");
    if (user && user.name) {
      return [user.name.firstName, user.name.lastName]
        .filter(Boolean)
        .join(" ");
    }
  } catch (e) {
    // no name then
  }
  return "";
}

module.exports = async function oauthCallback(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    refuse(res, 405, "Method not allowed");
    return;
  }
  let params = new URL(req.url, "http://localhost").searchParams;
  if (req.method === "POST") {
    try {
      params = new URLSearchParams(
        (await readBody(req, 32 * 1024)).toString("utf8"),
      );
    } catch (e) {
      toDone(res, { e: "That sign-in could not be finished. Try again." });
      return;
    }
  }
  const home = ownOrigin(req);
  const state = params.get("state") || "";
  const name = /^[\w-]{16,128}$/.test(state) ? cookieName(state) : "";
  const saved = name ? unseal(readCookie(req, name)) : null;
  if (name) {
    setCookie(res, name, "", 0, home.startsWith("https://"));
  }
  if (
    !home ||
    !saved ||
    saved.s !== state ||
    typeof saved.k !== "string" ||
    typeof saved.n !== "string"
  ) {
    toDone(res, {
      e: "That sign-in expired or was started in another browser. Try again.",
    });
    return;
  }
  const reply = (value) =>
    toDone(res, { n: saved.n, r: encryptFor(saved.k, value) });
  const spec = provider(saved.p);
  // only Apple answers with a form post
  if (!spec || (req.method === "POST") !== (spec.id === "apple")) {
    reply({ error: "That sign-in is not set up here." });
    return;
  }
  if (params.get("error")) {
    reply({
      error:
        params.get("error") === "access_denied" ||
        params.get("error") === "user_cancelled_authorize"
          ? "The sign-in was cancelled."
          : spec.label +
            " did not finish the sign-in (" +
            clean(params.get("error"), 80) +
            ")",
    });
    return;
  }
  const code = params.get("code") || "";
  if (!/^[\w.~+/=-]{4,2048}$/.test(code)) {
    reply({ error: spec.label + " did not send a sign-in code." });
    return;
  }
  const result = await requestTokens(spec, {
    grant_type: "authorization_code",
    code,
    redirect_uri: home + "/api/oauth/callback",
    code_verifier: spec.pkce ? saved.v : "",
  });
  if (result.error) {
    reply({ error: result.error });
    return;
  }
  if (spec.id === "apple") {
    const claims = jwtClaims(result.tokens.id_token);
    reply({
      provider: "apple",
      profile: {
        name: clean(appleName(params), 120),
        email: clean(claims.email, 254),
      },
    });
    return;
  }
  const tokens = result.tokens;
  // Vercel: the team the integration was installed to
  const teamId = params.get("teamId") || "";
  if (
    spec.id === "vercel" &&
    !tokens.team_id &&
    /^[\w-]{1,100}$/.test(teamId)
  ) {
    tokens.team_id = teamId;
  }
  reply({ provider: spec.id, tokens });
};
