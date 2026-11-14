// The publish broker (api/): its routes run in a local HTTP server and talk
// to a stand-in for the Surge API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { redirectSurge } from "./helpers/surge-stand-in.mjs";

const require = createRequire(import.meta.url);

// what the stand-in Surge saw, and how it answers
const surge = { requests: [], respond: null };
let surgeServer;
let brokerServer;
let broker;
let restoreFetch;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve("http://127.0.0.1:" + server.address().port);
    });
  });
}

before(async () => {
  surgeServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      surge.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      surge.respond(req, res);
    });
  });
  restoreFetch = redirectSurge(await listen(surgeServer));
  const routes = {
    "/api/status": require("../api/status.js"),
    "/api/surge/token": require("../api/surge/token.js"),
    "/api/surge/deploy": require("../api/surge/deploy.js"),
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
  surgeServer.close();
  brokerServer.close();
  restoreFetch();
});

function reset(respond) {
  surge.requests = [];
  surge.respond = respond;
}

const tarball = zlib.gzipSync(Buffer.from("a tarball"));

function deploy(query, init) {
  return fetch(broker + "/api/surge/deploy" + query, {
    method: "PUT",
    headers: Object.assign(
      {
        origin: broker,
        authorization: "Bearer abcdef0123456789",
        "content-type": "application/gzip",
      },
      init && init.headers,
    ),
    body: init && "body" in init ? init.body : tarball,
  });
}

test("status says what this broker can publish to", async () => {
  const response = await fetch(broker + "/api/status");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.broker, 1);
  assert.ok(body.publish.surge.maxBytes > 0);
});

test("only the page this deployment serves may call the broker", async () => {
  reset(() => assert.fail("Surge must not be called"));
  for (const origin of [undefined, "https://evil.example", "null"]) {
    const headers = { "content-type": "application/json" };
    if (origin) {
      headers.origin = origin;
    }
    const response = await fetch(broker + "/api/surge/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "a@b.co", password: "pw" }),
    });
    assert.equal(response.status, 403, String(origin));
  }
  const allowed = await fetch(broker + "/api/surge/deploy?domain=x.surge.sh", {
    method: "PUT",
    headers: { origin: "https://evil.example" },
    body: tarball,
  });
  assert.equal(allowed.status, 403);
  assert.equal(surge.requests.length, 0);
});

test("wrong methods are refused", async () => {
  const response = await fetch(broker + "/api/surge/deploy", {
    method: "GET",
  });
  assert.equal(response.status, 405);
});

test("a token is minted from email and password, which are not kept", async () => {
  reset((req, res) => {
    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ email: "me@example.com", token: "tok123456789" }));
  });
  const response = await fetch(broker + "/api/surge/token", {
    method: "POST",
    headers: { origin: broker, "content-type": "application/json" },
    body: JSON.stringify({ email: "me@example.com", password: "secret pw" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    email: "me@example.com",
    token: "tok123456789",
  });
  assert.equal(surge.requests.length, 1);
  const sent = surge.requests[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/token");
  assert.equal(
    sent.headers.authorization,
    "Basic " + Buffer.from("me@example.com:secret pw").toString("base64"),
  );
});

test("a wrong password comes back as 401 without the password", async () => {
  reset((req, res) => {
    res.statusCode = 401;
    res.setHeader("reason", "Password incorrect");
    res.end();
  });
  const response = await fetch(broker + "/api/surge/token", {
    method: "POST",
    headers: { origin: broker, "content-type": "application/json" },
    body: JSON.stringify({ email: "me@example.com", password: "hunter22" }),
  });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.match(text, /Password incorrect/);
  assert.doesNotMatch(text, /hunter22/);
});

test("bad token requests are refused before reaching Surge", async () => {
  reset(() => assert.fail("Surge must not be called"));
  for (const body of ["not json", "{}", '{"email":"x","password":"y"}']) {
    const response = await fetch(broker + "/api/surge/token", {
      method: "POST",
      headers: { origin: broker, "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400, body);
  }
});

test("a deploy passes the tarball and token on and streams Surge's answer back", async () => {
  reset((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-ndjson");
    res.write('{"type":"progress","id":"1"}\n');
    res.end('{"type":"info","domain":"my-site.surge.sh"}\n');
  });
  const response = await deploy("?domain=My-Site.surge.sh");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const lines = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    lines.map((line) => line.type),
    ["progress", "info"],
  );
  const sent = surge.requests[0];
  assert.equal(sent.method, "PUT");
  assert.equal(sent.url, "/my-site.surge.sh");
  assert.equal(
    sent.headers.authorization,
    "Basic " + Buffer.from("token:abcdef0123456789").toString("base64"),
  );
  assert.equal(sent.headers["content-type"], "application/gzip");
  assert.deepEqual(sent.body, tarball);
});

test("domains are hostnames only, never paths or other hosts", async () => {
  reset(() => assert.fail("Surge must not be called"));
  for (const domain of [
    "",
    "nodot",
    "a/b.surge.sh",
    "evil.example/..",
    "x.surge.sh:443",
    "127.0.0.1",
    "-bad.surge.sh",
    "a b.surge.sh",
    "%2e%2e",
  ]) {
    const response = await deploy("?domain=" + encodeURIComponent(domain));
    assert.equal(response.status, 422, domain);
  }
});

test("a deploy needs a token and a gzipped body", async () => {
  reset(() => assert.fail("Surge must not be called"));
  const noToken = await deploy("?domain=x.surge.sh", {
    headers: { authorization: "" },
  });
  assert.equal(noToken.status, 401);
  const notGzip = await deploy("?domain=x.surge.sh", { body: "plain text" });
  assert.equal(notGzip.status, 400);
});

test("a site over the size limit is refused with a way forward", async () => {
  reset(() => assert.fail("Surge must not be called"));
  const { MAX_BODY_BYTES } = require("../api/_lib/broker.js");
  const big = Buffer.alloc(MAX_BODY_BYTES + 1);
  big[0] = 0x1f;
  big[1] = 0x8b;
  const response = await deploy("?domain=x.surge.sh", { body: big });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /HAX CLI/);
});

test("Surge refusing a deploy comes back with its message", async () => {
  reset((req, res) => {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        messages: ["You do not have permission to publish to x.surge.sh"],
      }),
    );
  });
  const response = await deploy("?domain=x.surge.sh");
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /permission/);
});
