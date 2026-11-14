/**
 * GET /api/oauth/providers: the sign-in providers this deployment has
 * configured, with only their public parts (client id, where to send the
 * person, scopes). The page offers exactly these. See api/_lib/providers.js.
 */
const { guard, sendJson } = require("../_lib/broker.js");
const { publicList } = require("../_lib/providers.js");

module.exports = function oauthProviders(req, res) {
  if (!guard(req, res, ["GET"])) {
    return;
  }
  sendJson(res, 200, { providers: publicList() });
};
