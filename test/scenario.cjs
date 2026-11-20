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

// A multipart/form-data body with one file, the way the editor uploads one.
function multipart(filename, contentType, bytes) {
  const boundary = "----haxcmsparity" + filename.length;
  const head = Buffer.from(
    "--" +
      boundary +
      "\r\n" +
      'Content-Disposition: form-data; name="file"; filename="' +
      filename +
      '"\r\n' +
      "Content-Type: " +
      contentType +
      "\r\n\r\n",
  );
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
  return {
    contentType: "multipart/form-data; boundary=" + boundary,
    body: Buffer.concat([head, Buffer.from(bytes), tail]),
  };
}

// The smallest valid one-page PDF with a line of text, offsets computed so
// the cross-reference table is correct.
function tinyPdf(text) {
  const stream = "BT /F1 18 Tf 72 720 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += i + 1 + " 0 obj\n" + body + "\nendobj\n";
  });
  const xref = out.length;
  out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets) {
    out += String(offset).padStart(10, "0") + " 00000 n \n";
  }
  out +=
    "trailer\n<< /Size " +
    (objects.length + 1) +
    " /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}

function jsonOf(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return {};
  }
}

function dataOf(res) {
  const parsed = jsonOf(res);
  return parsed && parsed.data ? parsed.data : {};
}

// Word / PDF import and export and readability: packages the browser bundle
// once stubbed (haxtheweb/issues#3389). Each step records its status and a
// fact about the output that both runtimes must agree on.
async function documentSteps(
  adapter,
  steps,
  { userHeaders, siteHeaders, pageId },
) {
  const facts = {};
  // page text for readability and the site exports to work on. The
  // page-break sets the page's details, so it carries the title and
  // published flag the editor writes: a bare one renames the page "New page"
  // and unpublishes it, and readability skips unpublished pages.
  const saved = await adapter.request(
    "PATCH",
    "/_sites/" + SITE + "/x/api/v1/content/" + pageId,
    {
      headers: siteHeaders,
      json: {
        body:
          '<page-break title="A" published></page-break>' +
          "<p>The quick brown fox jumps over the lazy dog. " +
          "Readability formulas need several sentences to measure. " +
          "Extraordinarily complicated vocabulary increases difficulty.</p>",
      },
    },
  );
  steps.push({ step: "save page content", status: saved.status });
  const action = (name, file) =>
    adapter.request("POST", "/system/api/v1/actions/" + name, {
      headers: userHeaders,
      raw: file,
    });

  const html =
    "<h2>Parity heading</h2><p>Hello from a parity check. " +
    "This sentence is here so readability has words to count.</p>";
  const toDocx = await action(
    "html-to-docx",
    multipart("parity.html", "text/html", html),
  );
  steps.push({ step: "html-to-docx", status: toDocx.status });
  const docx = Buffer.from(dataOf(toDocx).contents || "", "base64");
  facts.docxIsZip = docx.subarray(0, 2).toString("latin1") === "PK";

  const fromDocx = await action(
    "docx-to-html",
    multipart(
      "parity.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx,
    ),
  );
  steps.push({ step: "docx-to-html", status: fromDocx.status });
  facts.docxRoundTrip = /Parity heading/.test(JSON.stringify(dataOf(fromDocx)));

  const fromPdf = await action(
    "pdf-to-html",
    multipart("parity.pdf", "application/pdf", tinyPdf("Hello PDF parity")),
  );
  steps.push({ step: "pdf-to-html", status: fromPdf.status });
  facts.pdfText = /Hello PDF parity/.test(JSON.stringify(dataOf(fromPdf)));

  const overview = await adapter.request(
    "GET",
    "/_sites/" + SITE + "/x/api/v1/reports/overview",
    { headers: siteHeaders },
  );
  steps.push({ step: "readability report", status: overview.status });
  const report = dataOf(overview);
  facts.readability = (report.data && report.data.readability) || null;

  for (const format of ["docx", "epub"]) {
    const exported = await adapter.request(
      "GET",
      "/_sites/" + SITE + "/x/api/v1/site/export/" + format,
      { headers: siteHeaders },
    );
    steps.push({ step: "site export " + format, status: exported.status });
    facts[format + "ExportIsZip"] = String(exported.text).slice(0, 2) === "PK";
  }
  return facts;
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
  const documents = await documentSteps(adapter, steps, {
    userHeaders: { "x-haxcms-user-token": userToken },
    siteHeaders,
    pageId: id("A"),
  });
  // ids are random uuids, so compare the outline by title / parent / order
  const titleOf = Object.fromEntries(
    manifest.items.map((i) => [i.id, i.title]),
  );
  const shape = manifest.items
    .map((i) => `${i.title} < ${titleOf[i.parent] || "(root)"} #${i.order}`)
    .sort();
  // llms-full.txt (the whole site as markdown; publishing packs it for
  // static hosts): compare its headings, the page bodies are empty here
  const llmsFull = await adapter.request(
    "GET",
    "/_sites/" + SITE + "/llms-full.txt",
    { headers: { accept: "text/markdown" } },
  );
  steps.push({ step: "llms-full.txt", status: llmsFull.status });
  const llmsHeadings = String(llmsFull.text)
    .split("\n")
    .filter((line) => /^#{1,2} /.test(line));
  return { steps, outline: shape, llmsHeadings, documents };
}

module.exports = { runScenario };
