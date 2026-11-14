// Publishing to hosts people sign in to (src/site/publish-hosts.js), each
// against a stand-in for the host's API that records what it was sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const hosts = require("../src/site/publish-hosts.js");

const enc = (text) => new TextEncoder().encode(text).buffer;
const FILES = [
  { path: "index.html", body: enc("<p>static</p>") },
  { path: "site.json", body: enc("{}") },
  { path: "files/a b.png", body: enc("png") },
];

// auth.js as the publishers use it, with every API call answered by `api`:
// (method, url, body) -> { status, body, headers }
function fakeAuth(api, session) {
  const calls = [];
  async function call(provider, url, init) {
    const method = (init && init.method) || "GET";
    let body = init && init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        // raw
      }
    }
    calls.push({
      provider,
      method,
      url,
      body,
      headers: (init && init.headers) || {},
    });
    const answer = (await api(method, url, body)) || { status: 404, body: {} };
    return new Response(
      JSON.stringify(answer.body === undefined ? {} : answer.body),
      {
        status: answer.status || 200,
        headers: Object.assign(
          { "content-type": "application/json" },
          answer.headers || {},
        ),
      },
    );
  }
  return {
    calls,
    call,
    async callJson(provider, url, init) {
      const response = await call(provider, url, init);
      const body = await response.json();
      if (!response.ok) {
        const error = new Error("answered " + response.status);
        error.status = response.status;
        throw error;
      }
      return body;
    },
    session: () => session || null,
  };
}

const quiet = () => {};

test("GitHub Pages: new repository, every file as a blob, one commit, Pages on", async () => {
  let blobs = 0;
  const auth = fakeAuth((method, url, body) => {
    const path = url.replace("https://api.github.com", "");
    if (path === "/user") return { body: { login: "Ada" } };
    if (path === "/user/installations")
      return { body: { installations: [{ account: { login: "ada" } }] } };
    if (method === "GET" && path === "/repos/Ada/my-site")
      return { status: 404 };
    if (path === "/user/repos")
      return {
        status: 201,
        body: {
          name: "my-site",
          owner: { login: "Ada" },
          default_branch: "main",
          html_url: "https://github.com/Ada/my-site",
        },
      };
    if (path === "/repos/Ada/my-site/git/ref/heads/main")
      return { body: { object: { sha: "parent-sha" } } };
    if (path === "/repos/Ada/my-site/git/blobs")
      return { status: 201, body: { sha: "blob" + blobs++ } };
    if (path === "/repos/Ada/my-site/git/trees")
      return { status: 201, body: { sha: "tree-sha" } };
    if (path === "/repos/Ada/my-site/git/commits")
      return { status: 201, body: { sha: "commit-sha" } };
    if (path === "/repos/Ada/my-site/git/refs/heads/main") return { body: {} };
    if (method === "GET" && path === "/repos/Ada/my-site/pages")
      return { status: 404 };
    if (method === "POST" && path === "/repos/Ada/my-site/pages")
      return {
        status: 201,
        body: { html_url: "https://ada.github.io/my-site/" },
      };
    return null;
  });
  const result = await hosts.publish("github", {
    auth,
    name: "my-site",
    files: FILES,
    status: quiet,
  });
  assert.equal(result.url, "https://ada.github.io/my-site/");
  const created = auth.calls.find((c) => c.url.endsWith("/user/repos"));
  assert.equal(created.body.auto_init, true);
  // the site's files and .nojekyll
  assert.equal(blobs, 4);
  const tree = auth.calls.find((c) => c.url.endsWith("/git/trees")).body.tree;
  assert.deepEqual(tree.map((entry) => entry.path).sort(), [
    ".nojekyll",
    "files/a b.png",
    "index.html",
    "site.json",
  ]);
  const commit = auth.calls.find((c) => c.url.endsWith("/git/commits")).body;
  assert.deepEqual(commit.parents, ["parent-sha"]);
  const ref = auth.calls.find((c) => c.url.endsWith("/git/refs/heads/main"));
  assert.equal(ref.method, "PATCH");
  assert.deepEqual(ref.body, { sha: "commit-sha", force: false });
  const pages = auth.calls.find(
    (c) => c.method === "POST" && c.url.endsWith("/pages"),
  );
  assert.deepEqual(pages.body.source, { branch: "main", path: "/" });
});

test("GitHub Pages: without the app installed, it says to install it and changes nothing", async () => {
  const auth = fakeAuth((method, url) => {
    if (url.endsWith("/user")) return { body: { login: "ada" } };
    if (url.endsWith("/user/installations"))
      return { body: { installations: [] } };
    assert.fail("nothing else may be called: " + method + " " + url);
  });
  await assert.rejects(
    hosts.publish("github", { auth, name: "x", files: FILES, status: quiet }),
    (error) => error.action === "install-github-app",
  );
});

test("GitLab Pages: files under public/, updates and deletions, CI file last", async () => {
  const auth = fakeAuth((method, url) => {
    const path = url.replace("https://gitlab.com/api/v4", "");
    if (path === "/user") return { body: { username: "ada" } };
    if (path === "/projects/ada%2Fmy-site")
      return {
        body: {
          id: 7,
          default_branch: "main",
          web_url: "https://gitlab.com/ada/my-site",
        },
      };
    if (path.startsWith("/projects/7/repository/tree"))
      return {
        body: [
          { type: "blob", path: "public/index.html" },
          { type: "blob", path: "public/old.html" },
          { type: "tree", path: "public" },
        ],
      };
    if (path === "/projects/7/repository/commits")
      return { status: 201, body: {} };
    if (path === "/projects/7/pages")
      return { body: { url: "https://my-site-abc.gitlab.io" } };
    return null;
  });
  const result = await hosts.publish("gitlab", {
    auth,
    name: "My Site",
    files: FILES,
    status: quiet,
  });
  assert.equal(result.url, "https://my-site-abc.gitlab.io");
  const commits = auth.calls.filter((c) =>
    c.url.endsWith("/repository/commits"),
  );
  assert.equal(commits.length, 1);
  const actions = commits[0].body.actions;
  const byPath = Object.fromEntries(
    actions.map((a) => [a.file_path, a.action]),
  );
  assert.equal(byPath["public/index.html"], "update");
  assert.equal(byPath["public/site.json"], "create");
  assert.equal(byPath["public/old.html"], "delete");
  assert.equal(actions[actions.length - 1].file_path, ".gitlab-ci.yml");
  const ci = Buffer.from(
    actions[actions.length - 1].content,
    "base64",
  ).toString();
  assert.match(ci, /^pages:/m);
  assert.match(ci, /- public/);
});

test("Codeberg Pages: webhook to the git-pages address first, then the pages branch", async () => {
  const auth = fakeAuth((method, url) => {
    const path = url.replace("https://codeberg.org/api/v1", "");
    if (path === "/user") return { body: { login: "Ada" } };
    if (method === "GET" && path === "/repos/Ada/my-site")
      return { status: 404 };
    if (path === "/user/repos")
      return {
        status: 201,
        body: {
          default_branch: "pages",
          html_url: "https://codeberg.org/Ada/my-site",
        },
      };
    if (method === "GET" && path === "/repos/Ada/my-site/hooks")
      return { body: [] };
    if (method === "POST" && path === "/repos/Ada/my-site/hooks")
      return { status: 201, body: {} };
    if (path === "/repos/Ada/my-site/branches")
      return { body: [{ name: "pages" }] };
    if (path.startsWith("/repos/Ada/my-site/git/trees/pages"))
      return {
        body: { tree: [{ type: "blob", path: "README.md", sha: "r1" }] },
      };
    if (path === "/repos/Ada/my-site/contents")
      return { status: 201, body: {} };
    return null;
  });
  const result = await hosts.publish("codeberg", {
    auth,
    name: "my-site",
    files: FILES,
    status: quiet,
  });
  assert.equal(result.url, "https://ada.codeberg.page/my-site/");
  const order = auth.calls.map(
    (c) => c.method + " " + c.url.replace("https://codeberg.org/api/v1", ""),
  );
  assert.ok(
    order.indexOf("POST /repos/Ada/my-site/hooks") <
      order.indexOf("POST /repos/Ada/my-site/contents"),
  );
  const hook = auth.calls.find(
    (c) => c.method === "POST" && c.url.endsWith("/hooks"),
  ).body;
  assert.equal(hook.config.url, "https://ada.codeberg.page/my-site/");
  assert.equal(hook.branch_filter, "pages");
  const contents = auth.calls.find((c) => c.url.endsWith("/contents")).body;
  assert.equal(contents.branch, "pages");
  const ops = Object.fromEntries(contents.files.map((f) => [f.path, f]));
  assert.equal(ops["index.html"].operation, "create");
  assert.equal(ops["README.md"].operation, "delete");
  assert.equal(ops["README.md"].sha, "r1");
});

test("Netlify: only the files Netlify asks for are uploaded", async () => {
  let required = null;
  const auth = fakeAuth((method, url, body) => {
    const path = url.replace("https://api.netlify.com/api/v1", "");
    if (path.startsWith("/sites?name=")) return { body: [] };
    if (method === "POST" && path === "/sites")
      return {
        status: 201,
        body: { id: "s1", ssl_url: "https://my-site.netlify.app" },
      };
    if (path === "/sites/s1/deploys") {
      // Netlify already has site.json
      required = Object.entries(body.files)
        .filter(([file]) => file !== "/site.json")
        .map(([, digest]) => digest);
      return { body: { id: "d1", required, state: "ready" } };
    }
    if (method === "PUT" && path.startsWith("/deploys/d1/files/"))
      return { body: {} };
    return null;
  });
  const result = await hosts.publish("netlify", {
    auth,
    name: "my-site",
    files: FILES,
    status: quiet,
  });
  assert.equal(result.url, "https://my-site.netlify.app");
  const deploy = auth.calls.find((c) =>
    c.url.endsWith("/sites/s1/deploys"),
  ).body;
  assert.deepEqual(Object.keys(deploy.files).sort(), [
    "/files/a b.png",
    "/index.html",
    "/site.json",
  ]);
  assert.match(deploy.files["/index.html"], /^[0-9a-f]{40}$/);
  const uploads = auth.calls
    .filter((c) => c.method === "PUT")
    .map((c) => c.url);
  assert.deepEqual(uploads.sort(), [
    "https://api.netlify.com/api/v1/deploys/d1/files/files/a%20b.png",
    "https://api.netlify.com/api/v1/deploys/d1/files/index.html",
  ]);
});

test("Vercel: files by digest, then a production deployment, in the integration's team", async () => {
  const auth = fakeAuth(
    (method, url) => {
      if (url.startsWith("https://api.vercel.com/v2/files"))
        return { body: {} };
      if (
        method === "POST" &&
        url.startsWith("https://api.vercel.com/v13/deployments")
      )
        return {
          body: {
            id: "dpl1",
            readyState: "READY",
            alias: ["my-site.vercel.app"],
          },
        };
      return null;
    },
    { team_id: "team_9" },
  );
  const result = await hosts.publish("vercel", {
    auth,
    name: "My Site",
    files: FILES,
    status: quiet,
  });
  assert.equal(result.url, "https://my-site.vercel.app");
  const uploads = auth.calls.filter((c) =>
    c.url.startsWith("https://api.vercel.com/v2/files"),
  );
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every((c) => c.url.endsWith("?teamId=team_9")));
  assert.match(uploads[0].headers["x-vercel-digest"], /^[0-9a-f]{40}$/);
  const deployment = auth.calls.find((c) => c.url.includes("/v13/deployments"));
  assert.equal(deployment.body.name, "my-site");
  assert.equal(deployment.body.target, "production");
  assert.equal(deployment.body.projectSettings.framework, null);
  assert.equal(deployment.body.files.length, 3);
});

test("names become what every host accepts", () => {
  assert.equal(hosts.slugName("My Great Site!"), "my-great-site");
  assert.equal(hosts.slugName("---"), "hax-site");
  assert.equal(hosts.slugName("a".repeat(80), 63).length, 63);
});

test("unknown hosts are refused", async () => {
  await assert.rejects(hosts.publish("__proto__", {}), /not a publish host/);
});
