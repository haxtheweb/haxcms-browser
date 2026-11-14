/**
 * POST /api/oauth/refresh  { provider, refresh_token }  ->  tokens
 *
 * A new access token for a sign-in the page already has, so storage and
 * publishing keep working past the first token's hour. See
 * api/_lib/oauth.js.
 */
const { guard, readJson, refuse, sendJson } = require("../_lib/broker.js");
const { provider } = require("../_lib/providers.js");
const { requestTokens } = require("../_lib/oauth.js");

module.exports = async function oauthRefresh(req, res) {
  if (!guard(req, res, ["POST"])) {
    return;
  }
  const input = await readJson(req);
  const spec = input ? provider(input.provider) : null;
  if (!spec || spec.id === "apple") {
    refuse(res, 404, "That sign-in provider is not set up here");
    return;
  }
  const refreshToken =
    typeof input.refresh_token === "string" ? input.refresh_token : "";
  if (!/^[\w.~+/=-]{8,4096}$/.test(refreshToken)) {
    refuse(res, 400, "Sign in again");
    return;
  }
  const result = await requestTokens(spec, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (result.error) {
    refuse(res, result.status, result.error);
    return;
  }
  sendJson(res, 200, result.tokens);
};
