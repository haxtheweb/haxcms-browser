/**
 * The publish broker on browser.hax.cloud (haxtheweb/issues#3341).
 *
 * Small Vercel functions that pass a request from the haxcms-browser page to
 * a publishing service and pass the answer back. They keep nothing: no
 * database, no files, no logs of what passed through. Credentials arrive
 * with each request and are forgotten when it ends.
 *
 * Rules this file keeps:
 * - Only the page that serves this deployment (its own origin), or an origin
 *   listed in HAX_BROKER_ALLOWED_ORIGINS, may call it: it is not a public
 *   proxy. Browsers always send Origin on POST/PUT, so a request without one
 *   is refused.
 * - Requests only ever go to the service's fixed address. What the caller
 *   sends (a domain) is validated and used as one path segment, never as a
 *   host.
 * - Passwords and tokens are never written to a log, a response header or an
 *   error message.
 */

// Vercel refuses request bodies over 4.5 MB; stop a little before that with
// a message the page can show.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function allowedOrigins(req) {
  const list = String(process.env.HAX_BROKER_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const host = String(req.headers.host || "");
  if (host) {
    list.push("https://" + host);
    // `vercel dev` and local tests
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      list.push("http://" + host);
    }
  }
  return list;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  return (
    typeof origin === "string" && allowedOrigins(req).indexOf(origin) !== -1
  );
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function refuse(res, status, message) {
  sendJson(res, status, { error: message });
}

// Standard checks every broker route starts with. Returns false when the
// request has already been answered.
function guard(req, res, methods) {
  if (methods.indexOf(req.method) === -1) {
    res.setHeader("allow", methods.join(", "));
    refuse(res, 405, "Method not allowed");
    return false;
  }
  if (req.method !== "GET" && !originAllowed(req)) {
    refuse(res, 403, "This broker only answers the HAXcms page it serves");
    return false;
  }
  return true;
}

// Read the raw request body, at most `limit` bytes.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) {
      const error = new Error("too large");
      error.status = 413;
      reject(error);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("too large");
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// A hostname to publish to: letters, digits and hyphens in dot-separated
// labels, at least two labels, no IP addresses, no ports, no paths.
function validDomain(value) {
  if (typeof value !== "string") {
    return null;
  }
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length < 4 || domain.length > 253) {
    return null;
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return null;
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return null;
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return null;
  }
  return domain;
}

// Surge tokens are opaque strings of letters and digits
function validToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{8,512}$/.test(value)
    ? value
    : null;
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? validToken(match[1]) : null;
}

function basic(user, pass) {
  return "Basic " + Buffer.from(user + ":" + pass, "utf8").toString("base64");
}

// The page's sign-in landing address on an allowed origin
// (src/site/oauth/callback.html), or null: the one redirect_uri the broker
// will finish a sign-in for.
function validRedirect(req, value) {
  if (typeof value !== "string" || value.length > 2048) {
    return null;
  }
  let target;
  try {
    target = new URL(value);
  } catch (e) {
    return null;
  }
  if (
    allowedOrigins(req).indexOf(target.origin) === -1 ||
    !/\/oauth\/callback\.html$/.test(target.pathname) ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  ) {
    return null;
  }
  return target.href;
}

// Read a small JSON body; null when it isn't one.
async function readJson(req, limit) {
  try {
    const value = JSON.parse(
      (await readBody(req, limit || 16 * 1024)).toString("utf8"),
    );
    return value && typeof value === "object" ? value : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  MAX_BODY_BYTES,
  allowedOrigins,
  validRedirect,
  readJson,
  originAllowed,
  sendJson,
  refuse,
  guard,
  readBody,
  validDomain,
  validToken,
  bearer,
  basic,
};
