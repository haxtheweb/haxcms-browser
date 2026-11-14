/**
 * POST /api/oauth/token
 *   { provider, code, redirect_uri, code_verifier? }  ->  tokens
 *
 * Finishes a sign-in the page started: trades the code the provider sent
 * back for tokens, with this deployment's client secret. redirect_uri must
 * be this page's own oauth/callback.html (the provider checks it matches the
 * one the sign-in started with). See api/_lib/oauth.js.
 */
const {
  guard,
  readJson,
  refuse,
  sendJson,
  validRedirect,
} = require("../_lib/broker.js");
const { provider } = require("../_lib/providers.js");
const { requestTokens } = require("../_lib/oauth.js");

module.exports = async function oauthToken(req, res) {
  if (!guard(req, res, ["POST"])) {
    return;
  }
  const input = await readJson(req);
  const spec = input ? provider(input.provider) : null;
  if (!spec || spec.id === "apple") {
    refuse(res, 404, "That sign-in provider is not set up here");
    return;
  }
  const redirectUri = validRedirect(req, input.redirect_uri);
  const code = typeof input.code === "string" ? input.code : "";
  const verifier =
    typeof input.code_verifier === "string" ? input.code_verifier : "";
  if (
    !redirectUri ||
    !/^[\w.~+/=-]{4,2048}$/.test(code) ||
    (verifier && !/^[\w.~-]{43,128}$/.test(verifier))
  ) {
    refuse(res, 400, "That sign-in could not be finished");
    return;
  }
  const result = await requestTokens(spec, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: spec.pkce ? verifier : "",
  });
  if (result.error) {
    refuse(res, result.status, result.error);
    return;
  }
  sendJson(res, 200, result.tokens);
};
