// The sign-in part of the broker (api/oauth/*): providers come from
// environment variables, codes are traded for tokens at a stand-in for each
// provider, and nothing secret reaches the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { redirectHosts } from "./helpers/surge-stand-in.mjs";

const require = createRequire(import.meta.url);

const provider = { requests: [], respond: null };
let providerServer;
let brokerServer;
let broker;
let restoreFetch;
const ENV = {
  HAX_OAUTH_GITHUB_CLIENT_ID: "gh-client",
  HAX_OAUTH_GITHUB_CLIENT_SECRET: "gh-secret-value",
  HAX_OAUTH_GITHUB_APP_SLUG: "hax-publish",
  HAX_OAUTH_GOOGLE_CLIENT_ID: "google-client",
  HAX_OAUTH_GOOGLE_CLIENT_SECRET: "google-secret-value",
  // half set up: no secret, so not offered
  HAX_OAUTH_DROPBOX_CLIENT_ID: "dropbox-client",
};
const appleKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve("http://127.0.0.1:" + server.address().port);
    });
  });
}

before(async () => {
  Object.assign(process.env, ENV, {
    HAX_OAUTH_APPLE_CLIENT_ID: "org.hax.browser",
    HAX_OAUTH_APPLE_TEAM_ID: "TEAM123456",
    HAX_OAUTH_APPLE_KEY_ID: "KEY1234567",
    // as pasted into an environment variable: line breaks written as \n
    HAX_OAUTH_APPLE_PRIVATE_KEY: appleKey.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .replace(/\n/g, "\\n"),
  });
  providerServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      provider.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        form: new URLSearchParams(Buffer.concat(chunks).toString()),
      });
      provider.respond(req, res);
    });
  });
  const standIn = await listen(providerServer);
  restoreFetch = redirectHosts({
    "https://github.com": standIn + "/github",
    "https://oauth2.googleapis.com": standIn + "/google",
    "https://appleid.apple.com": standIn + "/apple",
  });
  const routes = {
    "/api/oauth/providers": require("../api/oauth/providers.js"),
    "/api/oauth/token": require("../api/oauth/token.js"),
    "/api/oauth/refresh": require("../api/oauth/refresh.js"),
    "/api/oauth/apple": require("../api/oauth/apple.js"),
  };
  brokerServer = http.createServer((req, res) => {
    const route = routes[new URL(req.url, "http://x").pathname];
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    Promise.resolve(route(req, res)).catch((e) => {
      res.statusCode = 500;
      res.end(String(e));
    });
  });
  broker = await listen(brokerServer);
});

after(() => {
  restoreFetch();
  providerServer.close();
  brokerServer.close();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("HAX_OAUTH_")) {
      delete process.env[name];
    }
  }
});

function reset(respond) {
  provider.requests = [];
  provider.respond = respond;
}

function post(path, body) {
  return fetch(broker + path, {
    method: "POST",
    headers: { origin: broker, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const callback = () => broker + "/oauth/callback.html";

test("only fully configured providers are offered, without their secrets", async () => {
  const response = await fetch(broker + "/api/oauth/providers");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /secret-value|PRIVATE|BEGIN/);
  const { providers } = JSON.parse(text);
  assert.deepEqual(
    providers.map((item) => item.id),
    ["github", "google", "apple"],
  );
  const github = providers.find((item) => item.id === "github");
  assert.equal(github.clientId, "gh-client");
  assert.deepEqual(github.uses, ["identity", "publish"]);
  assert.equal(
    github.installUrl,
    "https://github.com/apps/hax-publish/installations/new",
  );
  const google = providers.find((item) => item.id === "google");
  assert.ok(
    google.scopes.includes("https://www.googleapis.com/auth/drive.file"),
  );
  assert.equal(google.params.access_type, "offline");
  assert.equal(
    providers.find((item) => item.id === "apple").callback,
    "broker",
  );
});

test("a code is traded for tokens with the client secret, and only token fields come back", async () => {
  reset((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        access_token: "gho_access",
        refresh_token: "ghr_refresh",
        expires_in: 28800,
        token_type: "bearer",
        something_else: "dropped",
      }),
    );
  });
  const verifier = "v".repeat(64);
  const response = await post("/api/oauth/token", {
    provider: "github",
    code: "the-code",
    redirect_uri: callback(),
    code_verifier: verifier,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    access_token: "gho_access",
    refresh_token: "ghr_refresh",
    expires_in: 28800,
    token_type: "bearer",
  });
  const sent = provider.requests[0];
  assert.equal(sent.url, "/github/login/oauth/access_token");
  assert.equal(sent.form.get("client_id"), "gh-client");
  assert.equal(sent.form.get("client_secret"), "gh-secret-value");
  assert.equal(sent.form.get("code"), "the-code");
  assert.equal(sent.form.get("code_verifier"), verifier);
  assert.equal(sent.form.get("grant_type"), "authorization_code");
  assert.equal(sent.form.get("redirect_uri"), callback());
});

test("the code is only finished for this page's own callback address", async () => {
  reset(() => assert.fail("the provider must not be called"));
  for (const redirect of [
    "https://evil.example/oauth/callback.html",
    broker + "/somewhere-else.html",
    broker + "/oauth/callback.html?x=1",
    "not a url",
  ]) {
    const response = await post("/api/oauth/token", {
      provider: "github",
      code: "the-code",
      redirect_uri: redirect,
    });
    assert.equal(response.status, 400, redirect);
  }
});

test("unknown, half set up and inherited names are not providers", async () => {
  reset(() => assert.fail("the provider must not be called"));
  for (const name of ["nope", "dropbox", "__proto__", "constructor", "apple"]) {
    const response = await post("/api/oauth/token", {
      provider: name,
      code: "the-code",
      redirect_uri: callback(),
    });
    assert.equal(response.status, 404, name);
  }
});

test("other origins can't use the broker", async () => {
  reset(() => assert.fail("the provider must not be called"));
  const response = await fetch(broker + "/api/oauth/token", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "github",
      code: "x",
      redirect_uri: callback(),
    }),
  });
  assert.equal(response.status, 403);
});

test("a provider's refusal comes back as an error, not a token", async () => {
  reset((req, res) => {
    res.setHeader("content-type", "application/json");
    // GitHub answers 200 with an error field
    res.end(JSON.stringify({ error: "bad_verification_code" }));
  });
  const response = await post("/api/oauth/token", {
    provider: "github",
    code: "stale",
    redirect_uri: callback(),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /bad_verification_code/);
});

test("refresh trades a refresh token for a new access token", async () => {
  reset((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "ya29.new", expires_in: 3599 }));
  });
  const response = await post("/api/oauth/refresh", {
    provider: "google",
    refresh_token: "1//refresh-token",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_token, "ya29.new");
  const sent = provider.requests[0];
  assert.equal(sent.url, "/google/token");
  assert.equal(sent.form.get("grant_type"), "refresh_token");
  assert.equal(sent.form.get("refresh_token"), "1//refresh-token");
  assert.equal(sent.form.get("client_secret"), "google-secret-value");
});

test("Apple's form post becomes a profile in the callback page's fragment", async () => {
  const idClaims = { email: "me@privaterelay.appleid.com", sub: "001" };
  const idToken =
    "e30." +
    Buffer.from(JSON.stringify(idClaims)).toString("base64url") +
    ".sig";
  reset((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "a", id_token: idToken }));
  });
  const state = "s".repeat(32);
  const response = await fetch(broker + "/api/oauth/apple", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      state,
      code: "apple-code",
      user: JSON.stringify({
        name: { firstName: "Ada", lastName: "<b>L</b>" },
      }),
    }).toString(),
  });
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.match(location, /^\/oauth\/callback\.html#/);
  const fragment = new URLSearchParams(location.split("#")[1]);
  assert.equal(fragment.get("state"), state);
  assert.equal(fragment.get("email"), idClaims.email);
  assert.equal(fragment.get("name"), "Ada bL/b");
  assert.equal(fragment.get("provider"), "apple");
  // no token is passed on
  assert.equal(fragment.get("access_token"), null);
  // the client secret Apple got is an ES256 token signed with our key
  const sent = provider.requests[0];
  const secret = sent.form.get("client_secret").split(".");
  const header = JSON.parse(Buffer.from(secret[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(secret[1], "base64url").toString());
  assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567" });
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(claims.sub, "org.hax.browser");
  assert.equal(claims.aud, "https://appleid.apple.com");
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(secret[0] + "." + secret[1]),
      { key: appleKey.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(secret[2], "base64url"),
    ),
  );
  assert.equal(sent.form.get("redirect_uri"), broker + "/api/oauth/apple");
});

test("Apple's post with a bad state is refused", async () => {
  reset(() => assert.fail("Apple must not be called"));
  const response = await fetch(broker + "/api/oauth/apple", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ state: "<script>", code: "x" }).toString(),
  });
  assert.equal(response.status, 400);
});
