// One saveOutline scenario, run against haxcms-nodejs on Node (real disk) and
// in the browser Worker (in-memory volume) through the same small adapter:
//   { createSite(name), saveOutline(body) -> {status, body}, readSiteJson() }
// Mirrors haxcms-nodejs test/_helpers/save-outline-child.cjs, including the
// failure cases that must leave site.json untouched.
const page = (id, title, parent, order) => ({
  id,
  title,
  parent,
  indent: parent ? 1 : 0,
  order,
  metadata: {},
});

async function runScenario(adapter) {
  const siteName = "parity";
  const steps = [];
  await adapter.createSite(siteName);
  let manifest = JSON.parse(await adapter.readSiteJson());
  const id = (title) => manifest.items.find((i) => i.title === title).id;
  const call = async (label, items) => {
    const before = await adapter.readSiteJson();
    const res = await adapter.saveOutline({ site: { name: siteName }, items });
    const after = await adapter.readSiteJson();
    manifest = JSON.parse(after);
    steps.push({
      step: label,
      status: res.status,
      siteJsonUnchanged: before === after,
    });
  };
  await call("seed A, B", [page("a", "A", null, 0), page("b", "B", null, 1)]);
  await call("add C under A, swap A and B", [
    page(id("A"), "A", null, 1),
    page(id("B"), "B", null, 0),
    page("c", "C", id("A"), 0),
  ]);
  await call("cycle (must fail without writing)", [
    page(id("A"), "A", id("B"), 0),
    page(id("B"), "B", id("A"), 0),
  ]);
  await call("self-parent (must fail without writing)", [
    page(id("A"), "A", id("A"), 0),
  ]);
  // ids are random uuids, so compare the outline by title / parent / order
  const titleOf = Object.fromEntries(
    manifest.items.map((i) => [i.id, i.title]),
  );
  const outline = manifest.items
    .map((i) => `${i.title} < ${titleOf[i.parent] || "(root)"} #${i.order}`)
    .sort();
  return { steps, outline };
}

module.exports = { runScenario };
