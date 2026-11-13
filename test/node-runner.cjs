// Runs the scenario on Node against real disk, in its own temp HAXcms root
// and HOME, and prints the result as JSON.
//   node node-runner.cjs <haxcms-nodejs src> [<base64 hash>:<password>]
// With a hash, also reports whether Node verifies a hash made in the browser.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-parity-"));
process.env.HOME = root;
process.env.HAXCMS_ROOT = root + "/";
process.chdir(root);

const { HAXCMS } = require(path.join(src, "lib/HAXCMS.js"));
const saveOutline = require(
  path.join(src, "siteRoutes/v1/routes/saveOutline.js"),
);
const { runScenario } = require("./scenario.cjs");

HAXCMS.validateRequestToken = () => true;
let siteDirectory = null;
const res = () => ({
  statusCode: 200,
  body: null,
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(o) {
    this.body = o;
    return this;
  },
});

runScenario({
  async createSite(name) {
    await HAXCMS.createSite(name);
    siteDirectory = (await HAXCMS.loadSite(name)).siteDirectory;
  },
  async saveOutline(body) {
    const r = res();
    await saveOutline(
      {
        headers: { "x-haxcms-site-token": "local" },
        haxcmsSiteApiAuth: { authenticated: true, userName: "local" },
        body,
      },
      r,
    );
    return { status: r.statusCode, body: r.body };
  },
  async readSiteJson() {
    return fs.readFileSync(path.join(siteDirectory, "site.json"), "utf8");
  },
})
  .then(async (result) => {
    const verify = (process.argv[3] || "").split(":");
    if (verify.length === 2) {
      result.verifiesBrowserHash = await HAXCMS.verifyStoredPassword(
        Buffer.from(verify[0], "base64").toString(),
        verify[1],
      );
    }
    process.stdout.write("RESULT " + JSON.stringify(result) + "\n");
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
