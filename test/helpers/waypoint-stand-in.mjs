// A stand-in for a Waypoint, answering what the Publish dialog uses: what it
// is (/.well-known/waypoint), the approval page, the one-time code for a pass
// (with the PKCE proof checked), the person's account, making a site, the
// upload, how a job is going, a preview link and a site's address. It answers
// pages of one allowed origin only, the way a Waypoint answers the websites
// its operator listed.
//
// The approval page answers by itself (a person would sign in and press
// Allow or Decline): `decline` makes it come back with access_denied.
import crypto from "node:crypto";
import http from "node:http";

export function startWaypoint(allowedOrigin, options = {}) {
  const state = {
    maxBytes: options.maxBytes || 50 * 1024 * 1024,
    limit: options.limit || 2,
    // names the person already has there
    sites: new Set(options.sites || []),
    decline: false,
    // makes the build fail with this reason
    failBuild: options.failBuild || "",
    requests: [],
    codes: new Map(),
    passes: new Set(),
    created: [],
    uploads: [],
    openers: [],
    jobs: new Map(),
    polls: 0,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const origin = "http://127.0.0.1:" + server.address().port;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      state.requests.push({
        method: req.method,
        path: url.pathname,
        origin: req.headers.origin || "",
      });
      const json = (status, value) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(value));
      };
      // a job is queued, then running with a line of progress, then done
      const startJob = (site, result, error) => {
        const id = crypto.randomBytes(6).toString("hex");
        state.jobs.set(id, { id, site, seen: 0, result, error });
        return { id, site, status: "queued", progress: [] };
      };
      if (url.pathname === "/.well-known/waypoint") {
        res.setHeader("access-control-allow-origin", "*");
        json(200, {
          waypoint: 1,
          name: "waypoint.test",
          kind: "publish",
          hosting: "static",
          beam: true,
          broadcast: true,
          access: "open",
          limits: { archiveBytes: 200 * 1024 * 1024, pages: 5000 },
          selfService: options.closed
            ? null
            : {
                domain: "sites.test",
                sitesPerAccount: state.limit,
                archiveBytes: state.maxBytes,
              },
          connect: options.closed
            ? null
            : {
                authorize: origin + "/connect/authorize",
                token: origin + "/connect/token",
                account: origin + "/api/v1/account",
                sites: origin + "/api/v1/account/sites",
              },
          endpoints: {
            site: origin + "/api/v1/sites/{name}",
            beams: origin + "/api/v1/sites/{name}/beams",
            broadcast: origin + "/api/v1/sites/{name}/broadcast",
            previewLink: origin + "/api/v1/sites/{name}/preview-link",
            jobs: origin + "/api/v1/jobs/{id}",
          },
        });
        return;
      }
      if (url.pathname === "/connect/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri"));
        if (redirect.origin !== allowedOrigin) {
          json(403, { error: "This website is not on the allowed list" });
          return;
        }
        const code = crypto.randomBytes(32).toString("base64url");
        state.codes.set(code, {
          challenge: url.searchParams.get("code_challenge"),
          method: url.searchParams.get("code_challenge_method"),
          redirect: redirect.href,
        });
        redirect.searchParams.set("state", url.searchParams.get("state"));
        if (state.decline) {
          redirect.searchParams.set("error", "access_denied");
        } else {
          redirect.searchParams.set("code", code);
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        // says whether this page can reach the page that opened the window
        res.end(
          "<!doctype html><title>Allow?</title><script>" +
            "fetch('/saw-opener?value=' + (window.opener === null ? 'none' : 'present'))" +
            ".then(function () { location.replace(" +
            JSON.stringify(redirect.href) +
            "); });</script>",
        );
        return;
      }
      if (url.pathname === "/saw-opener") {
        state.openers.push(url.searchParams.get("value"));
        res.end("ok");
        return;
      }
      const api =
        url.pathname === "/connect/token" ||
        url.pathname.startsWith("/api/v1/");
      if (!api) {
        json(404, { error: "Not found" });
        return;
      }
      // only the listed website's pages are answered
      if (req.headers.origin !== allowedOrigin) {
        json(403, { error: "This website is not on the allowed list" });
        return;
      }
      res.setHeader("access-control-allow-origin", allowedOrigin);
      res.setHeader("vary", "Origin");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader(
          "access-control-allow-headers",
          "authorization, content-type, idempotency-key",
        );
        res.end();
        return;
      }
      if (url.pathname === "/connect/token" && req.method === "POST") {
        const input = JSON.parse(body.toString() || "{}");
        const grant = state.codes.get(input.code);
        state.codes.delete(input.code);
        const proof = crypto
          .createHash("sha256")
          .update(String(input.code_verifier))
          .digest("base64url");
        if (
          !grant ||
          input.grant_type !== "authorization_code" ||
          grant.method !== "S256" ||
          grant.challenge !== proof ||
          grant.redirect !== new URL(input.redirect_uri).href
        ) {
          json(400, { error: "That approval is invalid or has expired" });
          return;
        }
        const pass = "wpc_" + crypto.randomBytes(32).toString("base64url");
        state.passes.add(pass);
        json(200, {
          access_token: pass,
          token_type: "Bearer",
          expires_in: 900,
        });
        return;
      }
      const pass = String(req.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      if (!state.passes.has(pass)) {
        json(401, { error: "Connect to this Waypoint first" });
        return;
      }
      const siteUrl = (name) => origin + "/sites/" + name + "/";
      if (url.pathname === "/api/v1/account" && req.method === "GET") {
        json(200, {
          account: {
            email: "person@example.org",
            limit: state.limit,
            domain: "sites.test",
            sites: Array.from(state.sites, (name) => ({
              name,
              url: siteUrl(name),
            })),
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/account/sites" && req.method === "POST") {
        const name = String(JSON.parse(body.toString() || "{}").name || "");
        state.created.push(name);
        if (state.sites.size >= state.limit) {
          json(202, {
            job: startJob(
              name,
              null,
              "Your account already has " +
                state.sites.size +
                " sites, which is the limit here. Remove one to add another",
            ),
          });
          return;
        }
        state.sites.add(name);
        json(202, { job: startJob(name, { name, url: siteUrl(name) }) });
        return;
      }
      const job = /^\/api\/v1\/jobs\/([a-f0-9]+)$/.exec(url.pathname);
      if (job && req.method === "GET") {
        state.polls += 1;
        const found = state.jobs.get(job[1]);
        if (!found) {
          json(404, { error: "No such job" });
          return;
        }
        found.seen += 1;
        const running = found.seen < 2;
        json(200, {
          job: {
            id: found.id,
            site: found.site,
            status: running ? "running" : found.error ? "failed" : "done",
            progress: ["Checking and sanitizing the upload", "Building"],
            result: running ? null : found.result,
            error: running ? null : found.error || null,
          },
        });
        return;
      }
      const site = /^\/api\/v1\/sites\/([a-z0-9-]+)(\/[a-z-]+)?$/.exec(
        url.pathname,
      );
      if (!site || !state.sites.has(site[1])) {
        json(403, { error: "That site is not in your account" });
        return;
      }
      const name = site[1];
      if (site[2] === "/beams" && req.method === "POST") {
        if (body.length > state.maxBytes) {
          json(413, { error: "The archive is larger than the limit" });
          return;
        }
        const live = url.searchParams.get("live") === "1";
        state.uploads.push({
          name,
          live,
          type: req.headers["content-type"],
          key: req.headers["idempotency-key"],
          body,
        });
        json(202, {
          job: startJob(
            name,
            { site: name, release: "26.11.0-u1234abcd", live, pending: !live },
            state.failBuild,
          ),
        });
        return;
      }
      if (site[2] === "/preview-link" && req.method === "POST") {
        json(202, {
          job: startJob(name, {
            site: name,
            link:
              origin + "/stage/" + name + "/__waypoint/preview?token=preview1",
          }),
        });
        return;
      }
      if (!site[2] && req.method === "GET") {
        json(200, { site: { name, status: "live", url: siteUrl(name) } });
        return;
      }
      json(404, { error: "Not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port,
        state,
        close: () => server.close(),
      });
    });
  });
}
