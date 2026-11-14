/**
 * POST /api/oauth/apple: where Sign in with Apple sends the person back.
 *
 * Apple posts the result as a form (it does not come back to the page the
 * way other providers do), so the broker finishes it here: it trades the
 * code for Apple's ID token, reads the email from it, takes the name Apple
 * sends the first time someone signs in, and sends the browser on to the
 * page's oauth/callback.html with only that profile and the state, in the
 * address fragment (never sent to any server). No token is passed on: Apple
 * is used for sign-in only.
 */
const { allowedOrigins, readBody, refuse } = require("../_lib/broker.js");
const { provider } = require("../_lib/providers.js");
const { requestTokens, jwtClaims } = require("../_lib/oauth.js");

function clean(value, max) {
  return String(value || "")
    .split("")
    .filter((char) => char.charCodeAt(0) >= 32 && !"<>\"'`".includes(char))
    .join("")
    .trim()
    .slice(0, max);
}

module.exports = async function appleCallback(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    refuse(res, 405, "Method not allowed");
    return;
  }
  const spec = provider("apple");
  const origins = allowedOrigins(req);
  // Apple's form post is a cross-site navigation, so there is no Origin to
  // check here; the page checks the state instead
  const home = origins.length ? origins[origins.length - 1] : "";
  if (!spec || !home) {
    refuse(res, 404, "Sign in with Apple is not set up here");
    return;
  }
  let form;
  try {
    form = new URLSearchParams((await readBody(req, 32 * 1024)).toString());
  } catch (e) {
    refuse(res, 400, "That sign-in could not be finished");
    return;
  }
  const state = form.get("state") || "";
  const code = form.get("code") || "";
  if (!/^[\w-]{16,128}$/.test(state) || !/^[\w.-]{4,2048}$/.test(code)) {
    refuse(res, 400, "That sign-in could not be finished");
    return;
  }
  const result = await requestTokens(spec, {
    grant_type: "authorization_code",
    code,
    redirect_uri: home + "/api/oauth/apple",
  });
  const fragment = new URLSearchParams();
  fragment.set("provider", "apple");
  fragment.set("state", state);
  if (result.error) {
    fragment.set("error", "Apple did not finish the sign-in");
  } else {
    const claims = jwtClaims(result.tokens.id_token);
    // the name only comes the first time someone signs in to this app
    let name = "";
    try {
      const user = JSON.parse(form.get("user") || "{}");
      if (user && user.name) {
        name = [user.name.firstName, user.name.lastName]
          .filter(Boolean)
          .join(" ");
      }
    } catch (e) {
      name = "";
    }
    fragment.set("name", clean(name, 120));
    fragment.set("email", clean(claims.email, 254));
  }
  res.statusCode = 303;
  res.setHeader("cache-control", "no-store");
  // a fixed address on this deployment; the profile rides in the fragment
  res.setHeader("location", "/oauth/callback.html#" + fragment.toString());
  res.end();
};
