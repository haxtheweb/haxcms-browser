// The sign-in part of the broker (api/oauth/*): providers come from
// environment variables, the broker runs the whole sign-in (start, callback,
// done) against a stand-in for each provider, and nothing secret reaches
// the page.
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
  HAX_OAUTH_STATE_SECRET: "test-state-secret-0123456789abcdefghijklmnop",
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
    "/api/oauth/start": require("../api/oauth/start.js"),
    "/api/oauth/callback": require("../api/oauth/callback.js"),
    "/api/oauth/done": require("../api/oauth/done.js"),
    "/api/oauth/refresh": require("../api/oauth/refresh.js"),
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

const state = require("../api/_lib/state.js");

function newKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function openBox(key, box) {
  const bytes = Buffer.from(box, "base64url");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

// open the popup at /api/oauth/start: where it sends the person, and the
// cookie it sets
async function start(id, nonce, key) {
  const query = new URLSearchParams({ provider: id, nonce, key });
  const response = await fetch(broker + "/api/oauth/start?" + query, {
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    cookie: response.headers.get("set-cookie") || "",
  };
}

// the fragment /api/oauth/done gets
function doneFragment(response) {
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.match(location, /^\/api\/oauth\/done#/);
  return new URLSearchParams(location.split("#")[1]);
}

const nonce = "n".repeat(32);

test("only fully configured providers are offered, with nothing but their names", async () => {
  const response = await fetch(broker + "/api/oauth/providers");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /secret-value|PRIVATE|BEGIN|client/);
  const { providers } = JSON.parse(text);
  assert.deepEqual(
    providers.map((item) => item.id),
    ["github", "google", "apple"],
  );
  const github = providers.find((item) => item.id === "github");
  assert.deepEqual(Object.keys(github).sort(), [
    "id",
    "installUrl",
    "label",
    "uses",
  ]);
  assert.deepEqual(github.uses, ["identity", "publish"]);
  assert.equal(
    github.installUrl,
    "https://github.com/apps/hax-publish/installations/new",
  );
});

test("without HAX_OAUTH_STATE_SECRET no sign-in is offered", async () => {
  const saved = process.env.HAX_OAUTH_STATE_SECRET;
  try {
    for (const value of ["", "too-short"]) {
      process.env.HAX_OAUTH_STATE_SECRET = value;
      const response = await fetch(broker + "/api/oauth/providers");
      assert.deepEqual((await response.json()).providers, []);
    }
  } finally {
    process.env.HAX_OAUTH_STATE_SECRET = saved;
  }
});

test("a sign-in runs start → provider → callback → done, and only the page's key opens the tokens", async () => {
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
  const key = newKey();
  const started = await start("github", nonce, key);
  assert.equal(started.status, 302);
  const authorize = new URL(started.location);
  assert.equal(
    authorize.origin + authorize.pathname,
    "https://github.com/login/oauth/authorize",
  );
  const params = authorize.searchParams;
  assert.equal(params.get("client_id"), "gh-client");
  assert.equal(params.get("redirect_uri"), broker + "/api/oauth/callback");
  assert.equal(params.get("code_challenge_method"), "S256");
  // nothing the page sent goes to the provider
  assert.doesNotMatch(started.location, new RegExp(nonce + "|" + key));
  const stateValue = params.get("state");
  assert.match(stateValue, /^[\w-]{32}$/);
  assert.match(started.cookie, new RegExp("^hax_oauth_" + stateValue + "="));
  assert.match(started.cookie, /HttpOnly/);
  assert.match(started.cookie, /Path=\/api\/oauth/);
  assert.match(started.cookie, /SameSite=Lax/);

  const response = await fetch(
    broker +
      "/api/oauth/callback?" +
      new URLSearchParams({ code: "the-code", state: stateValue }),
    { redirect: "manual", headers: { cookie: started.cookie.split(";")[0] } },
  );
  const fragment = doneFragment(response);
  // the cookie is cleared
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(fragment.get("n"), nonce);
  assert.doesNotMatch(fragment.toString(), /gho_access/);
  assert.deepEqual(openBox(key, fragment.get("r")), {
    provider: "github",
    tokens: {
      access_token: "gho_access",
      refresh_token: "ghr_refresh",
      expires_in: 28800,
      token_type: "bearer",
    },
  });
  assert.throws(() => openBox(newKey(), fragment.get("r")));

  const sent = provider.requests[0];
  assert.equal(sent.url, "/github/login/oauth/access_token");
  assert.equal(sent.form.get("client_id"), "gh-client");
  assert.equal(sent.form.get("client_secret"), "gh-secret-value");
  assert.equal(sent.form.get("code"), "the-code");
  assert.equal(sent.form.get("grant_type"), "authorization_code");
  assert.equal(sent.form.get("redirect_uri"), broker + "/api/oauth/callback");
  // the verifier from the cookie matches the challenge the provider got
  assert.equal(
    crypto
      .createHash("sha256")
      .update(sent.form.get("code_verifier"))
      .digest("base64url"),
    params.get("code_challenge"),
  );
});

test("a callback without this browser's cookie is not finished", async () => {
  reset(() => assert.fail("the provider must not be called"));
  const started = await start("github", nonce, newKey());
  const stateValue = new URL(started.location).searchParams.get("state");
  const cookie = started.cookie.split(";")[0];
  const [name, value] = [
    cookie.split("=")[0],
    cookie.slice(cookie.indexOf("=") + 1),
  ];
  const old = state.seal(
    Object.assign(
      JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString()),
      { t: Date.now() - 11 * 60 * 1000 },
    ),
  );
  for (const [query, sentCookie] of [
    // no cookie (another browser, or a forged link)
    [{ code: "c", state: stateValue }, ""],
    // a cookie for another sign-in
    [{ code: "c", state: "x".repeat(32) }, cookie],
    // tampered with
    [{ code: "c", state: stateValue }, name + "=" + value.replace(/.$/, "A")],
    // too old
    [{ code: "c", state: stateValue }, name + "=" + old],
    // not a state at all
    [{ code: "c", state: "<script>" }, cookie],
  ]) {
    const response = await fetch(
      broker + "/api/oauth/callback?" + new URLSearchParams(query),
      { redirect: "manual", headers: sentCookie ? { cookie: sentCookie } : {} },
    );
    const fragment = doneFragment(response);
    assert.equal(fragment.get("n"), null);
    assert.equal(fragment.get("r"), null);
    assert.match(fragment.get("e"), /Try again/);
  }
});

test("a cancelled sign-in comes back as an error, without calling the provider", async () => {
  reset(() => assert.fail("the provider must not be called"));
  const key = newKey();
  const started = await start("github", nonce, key);
  const stateValue = new URL(started.location).searchParams.get("state");
  const response = await fetch(
    broker +
      "/api/oauth/callback?" +
      new URLSearchParams({ error: "access_denied", state: stateValue }),
    { redirect: "manual", headers: { cookie: started.cookie.split(";")[0] } },
  );
  const fragment = doneFragment(response);
  assert.deepEqual(openBox(key, fragment.get("r")), {
    error: "The sign-in was cancelled.",
  });
});

test("a provider's refusal comes back as an error, not a token", async () => {
  reset((req, res) => {
    res.setHeader("content-type", "application/json");
    // GitHub answers 200 with an error field
    res.end(JSON.stringify({ error: "bad_verification_code" }));
  });
  const key = newKey();
  const started = await start("github", nonce, key);
  const stateValue = new URL(started.location).searchParams.get("state");
  const response = await fetch(
    broker +
      "/api/oauth/callback?" +
      new URLSearchParams({ code: "stale", state: stateValue }),
    { redirect: "manual", headers: { cookie: started.cookie.split(";")[0] } },
  );
  const result = openBox(key, doneFragment(response).get("r"));
  assert.match(result.error, /bad_verification_code/);
  assert.equal(result.tokens, undefined);
});

test("start refuses unknown, half set up and inherited providers, and bad nonces or keys", async () => {
  for (const name of ["nope", "dropbox", "__proto__", "constructor"]) {
    const started = await start(name, nonce, newKey());
    assert.equal(started.status, 303, name);
    assert.equal(started.cookie, "");
    const fragment = new URLSearchParams(started.location.split("#")[1]);
    assert.equal(fragment.get("n"), nonce);
    assert.match(fragment.get("e"), /not set up/);
  }
  for (const [badNonce, badKey] of [
    ["short", newKey()],
    ["<script>".repeat(4), newKey()],
    [nonce, "not-a-key"],
    [nonce, newKey().slice(0, 40)],
  ]) {
    const started = await start("github", badNonce, badKey);
    assert.equal(started.status, 303);
    assert.equal(started.cookie, "");
    const fragment = new URLSearchParams(started.location.split("#")[1]);
    assert.equal(fragment.get("n"), null);
    assert.ok(fragment.get("e"));
  }
});

test("done is one fixed page that only runs its own script", async () => {
  const response = await fetch(broker + "/api/oauth/done?x=<b>injected</b>");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /injected/);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  // the page's one inline script, between its tags
  const open = html.indexOf("<script>") + "<script>".length;
  const script = html.slice(open, html.indexOf("</" + "script>", open));
  const hash = crypto.createHash("sha256").update(script).digest("base64");
  assert.ok(csp.includes("'sha256-" + hash + "'"));
  assert.match(script, /postMessage\(message, globalThis\.location\.origin\)/);
});

test("other origins can't use refresh", async () => {
  reset(() => assert.fail("the provider must not be called"));
  const response = await fetch(broker + "/api/oauth/refresh", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "google", refresh_token: "1//refresh" }),
  });
  assert.equal(response.status, 403);
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

test("Apple posts back to the same callback, and the page gets a profile, no token", async () => {
  const idClaims = { email: "me@privaterelay.appleid.com", sub: "001" };
  const idToken =
    "e30." +
    Buffer.from(JSON.stringify(idClaims)).toString("base64url") +
    ".sig";
  reset((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "a", id_token: idToken }));
  });
  const key = newKey();
  const started = await start("apple", nonce, key);
  const authorize = new URL(started.location);
  assert.equal(authorize.searchParams.get("response_mode"), "form_post");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    broker + "/api/oauth/callback",
  );
  const stateValue = authorize.searchParams.get("state");
  const cookie = started.cookie.split(";")[0];
  // Apple only answers with a form post
  const asGet = await fetch(
    broker +
      "/api/oauth/callback?" +
      new URLSearchParams({ code: "apple-code", state: stateValue }),
    { redirect: "manual", headers: { cookie } },
  );
  assert.match(openBox(key, doneFragment(asGet).get("r")).error, /not set up/);
  const again = await start("apple", nonce, key);
  const againState = new URL(again.location).searchParams.get("state");
  const response = await fetch(broker + "/api/oauth/callback", {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: again.cookie.split(";")[0],
    },
    body: new URLSearchParams({
      state: againState,
      code: "apple-code",
      user: JSON.stringify({
        name: { firstName: "Ada", lastName: "<b>L</b>" },
      }),
    }).toString(),
  });
  const fragment = doneFragment(response);
  assert.deepEqual(openBox(key, fragment.get("r")), {
    provider: "apple",
    profile: { name: "Ada bL/b", email: idClaims.email },
  });
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
  assert.equal(sent.form.get("redirect_uri"), broker + "/api/oauth/callback");
});
