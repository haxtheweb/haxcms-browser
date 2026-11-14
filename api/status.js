/**
 * GET /api/status: what this deployment's publish broker can do. The
 * haxcms-browser page asks on start; where there is no broker (the GitHub
 * Pages copy, forks without one) the request fails and the page offers
 * download only. See api/_lib/broker.js.
 */
const { guard, sendJson, MAX_BODY_BYTES } = require("./_lib/broker.js");

module.exports = function status(req, res) {
  if (!guard(req, res, ["GET"])) {
    return;
  }
  sendJson(res, 200, {
    broker: 1,
    publish: {
      surge: { maxBytes: MAX_BODY_BYTES },
    },
  });
};
