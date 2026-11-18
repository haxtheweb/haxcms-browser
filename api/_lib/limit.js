/**
 * Request limits for the publish broker (see api/_lib/broker.js).
 *
 * Rules this file keeps:
 * - A caller gets a fixed number of requests per window on each route that
 *   reaches a publishing service, counted by the address the request came
 *   from and, where a route takes one, by the account it names. Past that the
 *   route answers 429 with Retry-After and the service is not called.
 * - Counts live in this function instance's memory only. They are keyed by a
 *   SHA-256 digest, so no address or email is held in the clear, and they are
 *   dropped when their window ends. Nothing is written anywhere.
 * - The limit is per instance: it slows a caller down, it is not a global
 *   quota. A deployment that needs one adds a rate limit rule in its host's
 *   firewall in front of /api/.
 */
const crypto = require("node:crypto");

const WINDOW_MS = 10 * 60 * 1000;
// most counters kept at once; when full, ended windows are dropped first and
// then the oldest
const MAX_KEYS = 5000;

// requests per window, by route and by what is counted
const LIMITS = {
  "surge-token": { address: 10, account: 5 },
  "surge-deploy": { address: 30 },
  "oauth-refresh": { address: 60 },
};

const counters = new Map();

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// The address the host says the request came from. Vercel sets x-real-ip and
// overwrites x-forwarded-for itself, so a caller cannot choose either there.
function callerAddress(req) {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) {
    return real.trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function prune(now) {
  for (const [key, entry] of counters) {
    if (entry.ends <= now) {
      counters.delete(key);
    }
  }
  while (counters.size >= MAX_KEYS) {
    counters.delete(counters.keys().next().value);
  }
}

// Count one request against `key`; the seconds to wait when over `max`, or 0.
function count(key, max, now) {
  let entry = counters.get(key);
  if (!entry || entry.ends <= now) {
    if (counters.size >= MAX_KEYS) {
      prune(now);
    }
    entry = { used: 0, ends: now + WINDOW_MS };
    counters.set(key, entry);
  }
  entry.used += 1;
  return entry.used > max ? Math.ceil((entry.ends - now) / 1000) : 0;
}

// True when the request is within the route's limits. Otherwise it has been
// answered with 429 and the route must stop.
function withinLimit(req, res, route, account) {
  const limits = LIMITS[route];
  if (!limits) {
    return true;
  }
  const now = Date.now();
  let wait = count(
    digest(route + "|address|" + callerAddress(req)),
    limits.address,
    now,
  );
  if (limits.account && typeof account === "string" && account) {
    wait = Math.max(
      wait,
      count(
        digest(route + "|account|" + account.toLowerCase()),
        limits.account,
        now,
      ),
    );
  }
  if (wait === 0) {
    return true;
  }
  res.statusCode = 429;
  res.setHeader("retry-after", String(wait));
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(
    JSON.stringify({
      error: "Too many requests. Try again in a few minutes.",
    }),
  );
  return false;
}

// for tests
function resetLimits() {
  counters.clear();
}

module.exports = { LIMITS, WINDOW_MS, withinLimit, callerAddress, resetLimits };
