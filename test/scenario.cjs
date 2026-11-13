// One scenario through the real HTTP API, run against haxcms-nodejs on Node
// (embedded app on a test-owned server, real disk) and in the browser Worker
// (embedded app, in-memory volume) through the same adapter:
//   { request(method, url, { headers, json }) -> { status, headers, text } }
// Both run in local mode, like `hax serve`. The outline steps mirror
// haxcms-nodejs test/_helpers/save-outline-child.cjs, including the failures
// that must leave site.json untouched.
const vm = require("node:vm");

const SITE = "parity";

const page = (id, title, parent, order) => ({
  id,
  title,
  parent,
  indent: parent ? 1 : 0,
  order,
  metadata: {},
});

// connection-settings is a script that sets window.appSettings
function appSettings(scriptSource) {
  const sandbox = { window: {} };
  vm.runInNewContext(String(scriptSource), sandbox, { timeout: 2000 });
  return sandbox.window.appSettings || {};
}

async function runScenario(adapter) {
  const steps = [];
  const record = (step, res) => {
    steps.push({ step, status: res.status });
    return res;
  };

  // the dashboard's handshake: user token, then create a site with it
  const settings = record(
    "connection-settings",
    await adapter.request("GET", "/system/api/v1/session/connection-settings", {
      headers: { accept: "application/javascript" },
    }),
  );
  // Local mode hands out no request tokens to an unauthenticated caller and
  // only checks that the header is present, so fall back to a placeholder.
  const userToken = appSettings(settings.text).userToken || "local";
  record(
    "create site",
    await adapter.request("POST", "/system/api/v1/sites", {
      headers: { "x-haxcms-user-token": userToken },
      json: { site: { name: SITE } },
    }),
  );
  // the site editor's handshake: site token for that site
  const siteSettings = await adapter.request(
    "GET",
    "/system/api/v1/session/connection-settings",
    {
      headers: {
        accept: "application/javascript",
        referer: "http://localhost/_sites/" + SITE + "/",
      },
    },
  );
  const siteToken = appSettings(siteSettings.text).siteToken || "local";
  const siteHeaders = { "x-haxcms-site-token": siteToken };

  const siteJson = async () =>
    (await adapter.request("GET", "/_sites/" + SITE + "/site.json")).text;
  let manifest = JSON.parse(await siteJson());
  const id = (title) => manifest.items.find((i) => i.title === title).id;
  const outline = async (label, items) => {
    const before = await siteJson();
    const res = await adapter.request(
      "PATCH",
      "/_sites/" + SITE + "/x/api/v1/site/outline",
      { headers: siteHeaders, json: { items } },
    );
    const after = await siteJson();
    manifest = JSON.parse(after);
    steps.push({
      step: label,
      status: res.status,
      siteJsonUnchanged: before === after,
    });
  };
  await outline("seed A, B", [
    page("a", "A", null, 0),
    page("b", "B", null, 1),
  ]);
  await outline("add C under A, swap A and B", [
    page(id("A"), "A", null, 1),
    page(id("B"), "B", null, 0),
    page("c", "C", id("A"), 0),
  ]);
  await outline("cycle (must fail without writing)", [
    page(id("A"), "A", id("B"), 0),
    page(id("B"), "B", id("A"), 0),
  ]);
  await outline("self-parent (must fail without writing)", [
    page(id("A"), "A", id("A"), 0),
  ]);
  record(
    "outline without a site token (refused)",
    await adapter.request(
      "PATCH",
      "/_sites/" + SITE + "/x/api/v1/site/outline",
      { json: { items: [] } },
    ),
  );
  // ids are random uuids, so compare the outline by title / parent / order
  const titleOf = Object.fromEntries(
    manifest.items.map((i) => [i.id, i.title]),
  );
  const shape = manifest.items
    .map((i) => `${i.title} < ${titleOf[i.parent] || "(root)"} #${i.order}`)
    .sort();
  return { steps, outline: shape };
}

module.exports = { runScenario };
