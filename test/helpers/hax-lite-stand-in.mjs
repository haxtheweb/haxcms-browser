// A stand-in for a HAX Lite, answering the "publish to HAX Lite" contract:
// what it accepts (/.well-known/hax-lite-publish), the approval page, the
// one-time code for a pass (with the PKCE proof checked), the upload, and how
// the import is going. It answers pages of one allowed origin only, the way
// a HAX Lite answers the websites its owner listed.
//
// The approval page answers by itself (a person would press Allow or
// Cancel): `decline` makes it come back with access_denied.
import crypto from "node:crypto";
import http from "node:http";

export function startHaxLite(allowedOrigin, options = {}) {
  const state = {
    doors: { upload: true, token: true, connect: true },
    maxBytes: options.maxBytes || 10 * 1024 * 1024,
    decline: false,
    requests: [],
    codes: new Map(),
    passes: new Map(),
    uploads: [],
    openers: [],
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
      if (url.pathname === "/.well-known/hax-lite-publish") {
        res.setHeader("access-control-allow-origin", "*");
        json(200, {
          service: "hax-lite-publish",
          version: 1,
          doors: state.doors,
          maxBytes: state.maxBytes,
          formats: ["application/zip", "application/gzip"],
          endpoints: {
            authorize: origin + "/publish/authorize",
            token: origin + "/api/publish/v1/token",
            sites: origin + "/api/publish/v1/sites",
            imports: origin + "/api/publish/v1/imports/{id}",
          },
        });
        return;
      }
      if (url.pathname === "/publish/authorize") {
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
      if (!url.pathname.startsWith("/api/publish/v1/")) {
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
        res.setHeader("access-control-allow-methods", "GET, POST");
        res.setHeader(
          "access-control-allow-headers",
          "Authorization, Content-Type, Idempotency-Key",
        );
        res.end();
        return;
      }
      if (url.pathname === "/api/publish/v1/token" && req.method === "POST") {
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
          json(400, { error: "This approval code is not valid" });
          return;
        }
        const pass = "hlc_" + crypto.randomBytes(32).toString("base64url");
        state.passes.set(pass, { uses: 1 });
        json(200, {
          access_token: pass,
          token_type: "Bearer",
          expires_in: 600,
        });
        return;
      }
      const pass = state.passes.get(
        String(req.headers.authorization || "").replace(/^Bearer /, ""),
      );
      if (!pass) {
        json(401, { error: "A publish token is required" });
        return;
      }
      const site = {
        slug: url.searchParams.get("slug"),
        url: origin + "/" + url.searchParams.get("slug") + "/",
      };
      if (url.pathname === "/api/publish/v1/sites" && req.method === "POST") {
        if (pass.uses < 1) {
          json(403, { error: "This publish approval has already been used" });
          return;
        }
        if (body.length > state.maxBytes) {
          json(413, { error: "The upload is larger than the limit" });
          return;
        }
        pass.uses -= 1;
        pass.site = site;
        state.uploads.push({
          slug: site.slug,
          title: url.searchParams.get("title"),
          type: req.headers["content-type"],
          key: req.headers["idempotency-key"],
          body,
        });
        json(202, {
          import: {
            id: "11111111-1111-4111-8111-111111111111",
            status: "pending",
            report: { pages: 1, files: 0, skipped: [], warnings: [] },
          },
          site: { ...site, status: "pending" },
        });
        return;
      }
      if (
        url.pathname.startsWith("/api/publish/v1/imports/") &&
        req.method === "GET"
      ) {
        state.polls += 1;
        json(200, {
          import: {
            id: "11111111-1111-4111-8111-111111111111",
            status: options.outcome || "complete",
            report: {
              pages: 1,
              files: 0,
              pagesImported: 1,
              filesImported: 0,
              skipped: options.skipped || [],
              warnings: [],
            },
          },
          site: { ...pass.site, status: "running" },
        });
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
