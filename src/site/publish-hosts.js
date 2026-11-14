/**
 * Publishing a site to hosts that take uploads straight from the browser
 * (haxtheweb/issues#3341): GitHub Pages, GitLab Pages, Codeberg Pages,
 * Netlify and Vercel. Each signs in through auth.js and then calls the
 * host's own API from this page; nothing passes through the broker, so
 * there is no size limit of ours.
 *
 * Every host gets the same files (the Worker's siteFiles message: what the
 * HAX CLI publishes, with llms-full.txt). Some hosts need one file of their
 * own, noted per host below (.nojekyll, .gitlab-ci.yml).
 *
 * HaxcmsPublishHosts.publish(id, { auth, name, files, status }) resolves
 * { url, note } where url is where the site is (or will be) live.
 *
 * Loaded as a plain script in the page, and with require() in tests.
 */
(function (root) {
  "use strict";

  // ---- helpers ------------------------------------------------------------

  function base64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let text = "";
    const step = 0x8000;
    for (let i = 0; i < view.length; i += step) {
      text += String.fromCharCode.apply(null, view.subarray(i, i + step));
    }
    return btoa(text);
  }

  async function sha1(bytes) {
    const digest = await root.crypto.subtle.digest("SHA-1", bytes);
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }

  // run `work` over items, `limit` at a time
  async function eachLimited(items, limit, work) {
    let next = 0;
    const runners = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
      runners.push(
        (async () => {
          while (next < items.length) {
            const index = next++;
            await work(items[index], index);
          }
        })(),
      );
    }
    await Promise.all(runners);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // a name every host accepts: lowercase letters, digits and hyphens
  function slugName(value, max) {
    return (
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max || 63)
        .replace(/-+$/, "") || "hax-site"
    );
  }

  function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function json(body) {
    return {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  function withMethod(method, init) {
    return Object.assign({ method }, init || {});
  }

  // call an API that may answer 404 (meaning "not there yet")
  async function maybe(promise) {
    try {
      return await promise;
    } catch (error) {
      if (error && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  function chunks(items, size, maxBytes) {
    const out = [];
    let current = [];
    let bytes = 0;
    for (const item of items) {
      const length = item.size || 0;
      if (
        current.length &&
        (current.length >= size || (maxBytes && bytes + length > maxBytes))
      ) {
        out.push(current);
        current = [];
        bytes = 0;
      }
      current.push(item);
      bytes += length;
    }
    if (current.length) {
      out.push(current);
    }
    return out;
  }

  // ---- GitHub Pages -------------------------------------------------------
  // A public repository named after the site, in the signed-in account,
  // with the site on its default branch and Pages serving that branch.
  // .nojekyll is added so Pages serves files and folders starting with _.

  async function github(ctx) {
    const auth = ctx.auth;
    const api = (path, init) =>
      auth.callJson(
        "github",
        "https://api.github.com" + path,
        Object.assign({}, init || {}, {
          headers: Object.assign(
            {
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            },
            (init && init.headers) || {},
          ),
        }),
      );
    const user = await api("/user");
    const owner = user.login;
    const repoName = String(ctx.name)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 100);
    // a GitHub App only reaches accounts it is installed on
    const installations = await api("/user/installations");
    const installed = (installations.installations || []).some(
      (item) =>
        item.account &&
        String(item.account.login).toLowerCase() === owner.toLowerCase(),
    );
    if (!installed) {
      const error = new Error(
        "The HAX app isn't installed on your GitHub account yet. Install it, then publish again.",
      );
      error.action = "install-github-app";
      throw error;
    }
    ctx.status("Finding the repository " + owner + "/" + repoName + "…");
    let repo = await maybe(
      api(
        "/repos/" +
          encodeURIComponent(owner) +
          "/" +
          encodeURIComponent(repoName),
      ),
    );
    if (!repo) {
      ctx.status("Making the repository " + owner + "/" + repoName + "…");
      repo = await api(
        "/user/repos",
        withMethod(
          "POST",
          json({
            name: repoName,
            description: "A HAX site, published from HAXcms",
            auto_init: true,
            has_issues: false,
            has_wiki: false,
          }),
        ),
      );
    }
    const base =
      "/repos/" +
      encodeURIComponent(repo.owner.login) +
      "/" +
      encodeURIComponent(repo.name);
    const branch = repo.default_branch || "main";
    // a new repository's first commit can take a moment to appear
    let ref = null;
    for (let attempt = 0; attempt < 10 && !ref; attempt++) {
      ref = await maybe(
        api(base + "/git/ref/heads/" + encodeURIComponent(branch)),
      );
      if (!ref) {
        await wait(1000);
      }
    }
    const files = ctx.files.concat(
      ctx.files.some((file) => file.path === ".nojekyll")
        ? []
        : [{ path: ".nojekyll", body: new ArrayBuffer(0) }],
    );
    const tree = [];
    let done = 0;
    await eachLimited(files, 6, async (file) => {
      const blob = await api(
        base + "/git/blobs",
        withMethod(
          "POST",
          json({ content: base64(file.body), encoding: "base64" }),
        ),
      );
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
      done++;
      ctx.status(
        "Uploading files to GitHub (" + done + " of " + files.length + ")…",
      );
    });
    ctx.status("Making the commit…");
    // a whole new tree: files the site no longer has are removed
    const newTree = await api(
      base + "/git/trees",
      withMethod("POST", json({ tree })),
    );
    const commit = await api(
      base + "/git/commits",
      withMethod(
        "POST",
        json({
          message: "Publish from HAXcms",
          tree: newTree.sha,
          parents: ref ? [ref.object.sha] : [],
        }),
      ),
    );
    if (ref) {
      await api(
        base + "/git/refs/heads/" + encodeURIComponent(branch),
        withMethod("PATCH", json({ sha: commit.sha, force: false })),
      );
    } else {
      await api(
        base + "/git/refs",
        withMethod(
          "POST",
          json({ ref: "refs/heads/" + branch, sha: commit.sha }),
        ),
      );
    }
    ctx.status("Turning on GitHub Pages…");
    let pages = await maybe(api(base + "/pages"));
    if (!pages) {
      pages = await api(
        base + "/pages",
        withMethod(
          "POST",
          json({ build_type: "legacy", source: { branch, path: "/" } }),
        ),
      );
    }
    return {
      url:
        (pages && pages.html_url) ||
        "https://" + owner.toLowerCase() + ".github.io/" + repo.name + "/",
      note: "GitHub Pages usually takes about a minute to build the first time.",
      source: repo.html_url,
    };
  }

  // ---- GitLab Pages -------------------------------------------------------
  // A public project named after the site, with the site in public/ and a
  // .gitlab-ci.yml whose pages job publishes that folder.

  const GITLAB_CI =
    "# Published from HAXcms: the site is already built, in public/\n" +
    "pages:\n" +
    "  stage: deploy\n" +
    "  script:\n" +
    '    - echo "Publishing public/"\n' +
    "  artifacts:\n" +
    "    paths:\n" +
    "      - public\n" +
    "  rules:\n" +
    "    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n";

  async function gitlab(ctx) {
    const auth = ctx.auth;
    const API = "https://gitlab.com/api/v4";
    const api = (path, init) => auth.callJson("gitlab", API + path, init);
    const user = await api("/user");
    const path = slugName(ctx.name, 100);
    const fullPath = user.username + "/" + path;
    ctx.status("Finding the project " + fullPath + "…");
    let project = await maybe(api("/projects/" + encodeURIComponent(fullPath)));
    if (!project) {
      ctx.status("Making the project " + fullPath + "…");
      project = await api(
        "/projects",
        withMethod(
          "POST",
          json({
            name: ctx.name,
            path,
            visibility: "public",
            initialize_with_readme: false,
            description: "A HAX site, published from HAXcms",
          }),
        ),
      );
    }
    const id = encodeURIComponent(project.id);
    const branch = project.default_branch || "main";
    // what the branch has now, so each file is a create or an update and
    // files the site no longer has are deleted
    const existing = new Set();
    for (let page = 1; page; ) {
      const response = await auth.call(
        "gitlab",
        API +
          "/projects/" +
          id +
          "/repository/tree?recursive=true&per_page=100&ref=" +
          encodeURIComponent(branch) +
          "&page=" +
          page,
      );
      if (response.status === 404) {
        break; // an empty project has no branch yet
      }
      if (!response.ok) {
        throw new Error("GitLab answered " + response.status);
      }
      for (const entry of await response.json()) {
        if (entry.type === "blob") {
          existing.add(entry.path);
        }
      }
      page = Number(response.headers.get("x-next-page")) || 0;
    }
    const wanted = ctx.files.map((file) => ({
      path: "public/" + file.path,
      body: file.body,
      size: file.body.byteLength,
    }));
    wanted.push({
      path: ".gitlab-ci.yml",
      body: new TextEncoder().encode(GITLAB_CI).buffer,
      size: GITLAB_CI.length,
    });
    const keep = new Set(wanted.map((file) => file.path));
    const actions = wanted.map((file) => ({
      action: existing.has(file.path) ? "update" : "create",
      file_path: file.path,
      content: base64(file.body),
      encoding: "base64",
      size: file.size,
    }));
    for (const old of existing) {
      if (!keep.has(old)) {
        actions.push({ action: "delete", file_path: old, size: 0 });
      }
    }
    // several commits for a big site, so no single request is huge; the
    // .gitlab-ci.yml goes in the last one so Pages runs once, at the end
    actions.sort((a, b) =>
      a.file_path === ".gitlab-ci.yml"
        ? 1
        : b.file_path === ".gitlab-ci.yml"
          ? -1
          : 0,
    );
    const batches = chunks(actions, 200, 20 * 1024 * 1024);
    let created = existing.size > 0;
    for (let i = 0; i < batches.length; i++) {
      ctx.status(
        "Committing to GitLab (" + (i + 1) + " of " + batches.length + ")…",
      );
      await api(
        "/projects/" + id + "/repository/commits",
        withMethod(
          "POST",
          json({
            branch,
            commit_message:
              "Publish from HAXcms" +
              (batches.length > 1
                ? " (" + (i + 1) + "/" + batches.length + ")"
                : ""),
            actions: batches[i].map((action) => {
              const copy = Object.assign({}, action);
              delete copy.size;
              return copy;
            }),
          }),
        ),
      );
      created = true;
    }
    let url = "";
    const pages = created
      ? await maybe(api("/projects/" + id + "/pages"))
      : null;
    if (pages && pages.url) {
      url = pages.url;
    }
    return {
      url: url || project.web_url + "/pages",
      note: url
        ? "GitLab builds the site with CI first; it is live when the pipeline finishes."
        : "GitLab builds the site with CI first. The address appears under Deploy > Pages in the project once the pipeline finishes. New GitLab accounts must verify their identity before CI runs.",
      source: project.web_url,
    };
  }

  // ---- Codeberg Pages -----------------------------------------------------
  // A public repository named after the site, with the site on a "pages"
  // branch, and the webhook Codeberg's git-pages server needs to publish it
  // (https://docs.codeberg.org/codeberg-pages/).

  async function codeberg(ctx) {
    const auth = ctx.auth;
    const API = "https://codeberg.org/api/v1";
    const api = (path, init) => auth.callJson("codeberg", API + path, init);
    const user = await api("/user");
    const owner = user.login;
    const repoName = slugName(ctx.name, 100);
    const base =
      "/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repoName);
    const siteUrl =
      "https://" + owner.toLowerCase() + ".codeberg.page/" + repoName + "/";
    ctx.status("Finding the repository " + owner + "/" + repoName + "…");
    let repo = await maybe(api(base));
    if (!repo) {
      ctx.status("Making the repository " + owner + "/" + repoName + "…");
      repo = await api(
        "/user/repos",
        withMethod(
          "POST",
          json({
            name: repoName,
            description: "A HAX site, published from HAXcms",
            auto_init: true,
            default_branch: "pages",
            private: false,
          }),
        ),
      );
    }
    // the webhook first, so the push below publishes
    const hooks = (await maybe(api(base + "/hooks"))) || [];
    const hasHook = hooks.some(
      (hook) => hook.config && String(hook.config.url).indexOf(siteUrl) === 0,
    );
    if (!hasHook) {
      ctx.status("Connecting the repository to Codeberg Pages…");
      await api(
        base + "/hooks",
        withMethod(
          "POST",
          json({
            type: "forgejo",
            active: true,
            events: ["push"],
            branch_filter: "pages",
            config: { url: siteUrl, content_type: "json" },
          }),
        ),
      );
    }
    const branches = (await maybe(api(base + "/branches"))) || [];
    const hasPages = branches.some((item) => item.name === "pages");
    const existing = new Map();
    if (hasPages) {
      const tree = await maybe(
        api(base + "/git/trees/pages?recursive=true&per_page=10000"),
      );
      for (const entry of (tree && tree.tree) || []) {
        if (entry.type === "blob") {
          existing.set(entry.path, entry.sha);
        }
      }
    }
    const keep = new Set(ctx.files.map((file) => file.path));
    const operations = ctx.files.map((file) => ({
      operation: existing.has(file.path) ? "update" : "create",
      path: file.path,
      content: base64(file.body),
      sha: existing.get(file.path),
      size: file.body.byteLength,
    }));
    for (const [path, sha] of existing) {
      if (!keep.has(path)) {
        operations.push({ operation: "delete", path, sha, size: 0 });
      }
    }
    const batches = chunks(operations, 200, 20 * 1024 * 1024);
    let branchReady = hasPages;
    for (let i = 0; i < batches.length; i++) {
      ctx.status(
        "Committing to Codeberg (" + (i + 1) + " of " + batches.length + ")…",
      );
      const body = {
        message:
          "Publish from HAXcms" +
          (batches.length > 1
            ? " (" + (i + 1) + "/" + batches.length + ")"
            : ""),
        files: batches[i].map((item) => {
          const copy = Object.assign({}, item);
          delete copy.size;
          return copy;
        }),
      };
      if (branchReady) {
        body.branch = "pages";
      } else {
        body.branch = repo.default_branch || "main";
        body.new_branch = "pages";
      }
      await api(base + "/contents", withMethod("POST", json(body)));
      branchReady = true;
    }
    return {
      url: siteUrl,
      note: "Codeberg publishes the pages branch when its webhook runs; this can take a minute.",
      source: repo.html_url,
    };
  }

  // ---- Netlify ------------------------------------------------------------
  // A Netlify site named after the site; a file-digest deploy, so only
  // files Netlify doesn't already have are uploaded.

  async function netlify(ctx) {
    const auth = ctx.auth;
    const API = "https://api.netlify.com/api/v1";
    const api = (path, init) => auth.callJson("netlify", API + path, init);
    const name = slugName(ctx.name, 63);
    ctx.status("Finding the Netlify site " + name + "…");
    const found = await api(
      "/sites?name=" + encodeURIComponent(name) + "&filter=all",
    );
    let site = (found || []).find((item) => item.name === name) || null;
    if (!site) {
      ctx.status("Making the Netlify site " + name + "…");
      try {
        site = await api("/sites", withMethod("POST", json({ name })));
      } catch (error) {
        if (error && error.status === 422) {
          // the name is taken by someone else: let Netlify pick one
          site = await api("/sites", withMethod("POST", json({})));
        } else {
          throw error;
        }
      }
    }
    ctx.status("Working out which files changed…");
    const digests = {};
    const byDigest = new Map();
    for (const file of ctx.files) {
      const digest = await sha1(file.body);
      digests["/" + file.path] = digest;
      byDigest.set(digest, file);
    }
    const deploy = await api(
      "/sites/" + encodeURIComponent(site.id) + "/deploys",
      withMethod("POST", json({ files: digests, async: false })),
    );
    const required = deploy.required || [];
    let done = 0;
    await eachLimited(required, 6, async (digest) => {
      const file = byDigest.get(digest);
      if (!file) {
        return;
      }
      await api(
        "/deploys/" +
          encodeURIComponent(deploy.id) +
          "/files/" +
          encodePath(file.path),
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: file.body,
        },
      );
      done++;
      ctx.status(
        "Uploading to Netlify (" + done + " of " + required.length + ")…",
      );
    });
    let state = deploy;
    for (let attempt = 0; attempt < 60 && state.state !== "ready"; attempt++) {
      if (state.state === "error") {
        throw new Error(
          "Netlify could not publish: " + (state.error_message || "error"),
        );
      }
      await wait(2000);
      state = await api("/deploys/" + encodeURIComponent(deploy.id));
    }
    return {
      url: site.ssl_url || site.url || state.ssl_url,
      note: "Netlify's plan limits for your account apply.",
      source: site.admin_url,
    };
  }

  // ---- Vercel -------------------------------------------------------------
  // A Vercel project named after the site; each file uploaded by its
  // digest (skipped when Vercel has it), then one production deployment.

  async function vercel(ctx) {
    const auth = ctx.auth;
    const session = auth.session("vercel") || {};
    const team = session.team_id
      ? "teamId=" + encodeURIComponent(session.team_id)
      : "";
    const API = "https://api.vercel.com";
    const withTeam = (path) =>
      path + (team ? (path.indexOf("?") === -1 ? "?" : "&") + team : "");
    const name = slugName(ctx.name, 100);
    const listed = [];
    let done = 0;
    ctx.status("Uploading to Vercel…");
    await eachLimited(ctx.files, 6, async (file) => {
      const digest = await sha1(file.body);
      const response = await auth.call("vercel", API + withTeam("/v2/files"), {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-vercel-digest": digest,
        },
        body: file.body,
      });
      if (!response.ok && response.status !== 409) {
        throw new Error(
          "Vercel did not take " + file.path + " (" + response.status + ")",
        );
      }
      listed.push({ file: file.path, sha: digest, size: file.body.byteLength });
      done++;
      ctx.status(
        "Uploading to Vercel (" + done + " of " + ctx.files.length + ")…",
      );
    });
    ctx.status("Starting the deployment…");
    const deployment = await auth.callJson(
      "vercel",
      API + withTeam("/v13/deployments"),
      withMethod(
        "POST",
        json({
          name,
          files: listed,
          target: "production",
          projectSettings: {
            framework: null,
            buildCommand: null,
            installCommand: null,
            outputDirectory: null,
          },
        }),
      ),
    );
    let state = deployment;
    for (
      let attempt = 0;
      attempt < 60 && state.readyState !== "READY";
      attempt++
    ) {
      if (state.readyState === "ERROR" || state.readyState === "CANCELED") {
        throw new Error("Vercel could not publish (" + state.readyState + ")");
      }
      await wait(2000);
      state = await auth.callJson(
        "vercel",
        API + withTeam("/v13/deployments/" + encodeURIComponent(deployment.id)),
      );
    }
    const alias = (state.alias && state.alias[0]) || name + ".vercel.app";
    return {
      url: "https://" + alias,
      note: "Vercel's Hobby plan is for personal, non-commercial use.",
      source: "",
    };
  }

  const HOSTS = {
    github: {
      label: "GitHub Pages",
      provider: "github",
      run: github,
      about:
        "Makes a public repository named after the site in your GitHub account and turns on GitHub Pages. Needs the HAX app installed on your account.",
    },
    gitlab: {
      label: "GitLab Pages",
      provider: "gitlab",
      run: gitlab,
      about:
        "Makes a public GitLab project named after the site; GitLab CI then publishes it. New GitLab accounts must verify their identity before CI runs.",
    },
    codeberg: {
      label: "Codeberg Pages",
      provider: "codeberg",
      run: codeberg,
      about:
        "Makes a public Codeberg repository named after the site and publishes its pages branch at your-name.codeberg.page.",
    },
    netlify: {
      label: "Netlify",
      provider: "netlify",
      run: netlify,
      about:
        "Makes a Netlify site named after the site (or another free name) and deploys it. Your Netlify plan's limits apply.",
    },
    vercel: {
      label: "Vercel",
      provider: "vercel",
      run: vercel,
      about:
        "Makes a Vercel project named after the site and deploys it to production. Vercel's Hobby plan is for personal, non-commercial use.",
    },
  };

  const api = {
    HOSTS,
    slugName,
    base64,
    chunks,
    async publish(id, ctx) {
      if (!Object.prototype.hasOwnProperty.call(HOSTS, id)) {
        throw new Error("not a publish host: " + String(id));
      }
      return HOSTS[id].run(ctx);
    },
  };

  /* global module */
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.HaxcmsPublishHosts = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
