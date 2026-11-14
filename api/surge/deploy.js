/**
 * PUT /api/surge/deploy?domain=<domain>
 *   Authorization: Bearer <surge token>
 *   body: the site as a gzipped tarball (entries under "./")
 *
 * Publishes one site to Surge and streams Surge's answer back unchanged:
 * newline-delimited JSON, where a line with "type": "info" means the site is
 * live (https://surge.sh/docs/api/deploys). The page builds the tarball
 * itself (src/runtime/publish.cjs); this only passes it on, so it does not
 * depend on Surge accepting requests from browsers, and the token never
 * shows up in a browser's network log for another host.
 *
 * Bodies over MAX_BODY_BYTES are refused with 413: Vercel functions cannot
 * take more. See api/_lib/broker.js for the rules every broker route keeps.
 */
const {
  MAX_BODY_BYTES,
  guard,
  readBody,
  refuse,
  validDomain,
  bearer,
  basic,
} = require("../_lib/broker.js");

module.exports = async function surgeDeploy(req, res) {
  if (!guard(req, res, ["PUT"])) {
    return;
  }
  const query = new URL(req.url, "http://broker.invalid").searchParams;
  const domain = validDomain(query.get("domain"));
  if (!domain) {
    refuse(res, 422, "That is not a domain Surge can publish to");
    return;
  }
  const token = bearer(req);
  if (!token) {
    refuse(res, 401, "A Surge token is needed to publish");
    return;
  }
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e && e.status === 413) {
      refuse(
        res,
        413,
        "This site is too large to publish through browser.hax.cloud. Download it and publish it with the HAX CLI instead.",
      );
    } else {
      refuse(res, 400, "The site could not be read");
    }
    return;
  }
  // a gzip stream starts with 1f 8b
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) {
    refuse(res, 400, "Send the site as a gzipped tarball");
    return;
  }
  let upstream;
  try {
    // a fixed host; the validated domain is only ever the path
    upstream = await fetch(
      "https://surge.surge.sh/" + encodeURIComponent(domain),
      {
        method: "PUT",
        headers: {
          authorization: basic("token", token),
          "content-type": "application/gzip",
          accept: "application/x-ndjson",
          "content-length": String(body.length),
        },
        body,
      },
    );
  } catch (e) {
    refuse(res, 502, "Surge could not be reached");
    return;
  }
  if (!upstream.ok) {
    let message = "Surge refused the publish (" + upstream.status + ")";
    try {
      const detail = await upstream.json();
      if (detail && Array.isArray(detail.messages) && detail.messages.length) {
        message = detail.messages.map(String).join(" ");
      }
    } catch (e) {
      // not JSON: keep the status message
    }
    const reason = upstream.headers.get("reason");
    if (reason && upstream.status === 401) {
      message += " (" + reason + ")";
    }
    refuse(res, upstream.status === 401 ? 401 : upstream.status, message);
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  }
  res.end();
};
