// Runs the scenario against haxcms-nodejs on Node: app.js loaded with
// HAXCMS_EMBEDDED=1 in local mode, served by a server this script owns, in
// its own temp HAXcms root and HOME. Prints the result as JSON.
//   node node-runner.cjs <haxcms-nodejs src> [<base64 hash>:<password>]
// With a hash, also reports whether Node verifies a hash made in the browser.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const src = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-browser-parity-"));
process.env.HOME = root;
process.env.HAXCMS_ROOT = root + "/";
process.env.HAXCMS_EMBEDDED = "1";
process.env.HAXCMS_DISABLE_JWT_CHECKS = "true";
delete process.env.PORT;
process.chdir(root);

const appModule = require(path.join(src, "app.js"));
const { HAXCMS } = require(path.join(src, "lib/HAXCMS.js"));
const { runScenario } = require("./scenario.cjs");

function request(port, method, url, options) {
  const opts = options || {};
  const body = opts.json ? Buffer.from(JSON.stringify(opts.json)) : null;
  const headers = Object.assign({ host: "localhost" }, opts.headers || {});
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: url, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

let server = null;
appModule.appReady
  .then(async () => {
    server = http.createServer(appModule.app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const result = await runScenario({
      request: (method, url, options) => request(port, method, url, options),
    });
    const verify = (process.argv[3] || "").split(":");
    if (verify.length === 2) {
      result.verifiesBrowserHash = await HAXCMS.verifyStoredPassword(
        Buffer.from(verify[0], "base64").toString(),
        verify[1],
      );
    }
    process.stdout.write("RESULT " + JSON.stringify(result) + "\n");
  })
  .catch((e) => {
    process.stdout.write("ERROR " + String((e && e.stack) || e) + "\n");
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) {
      server.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
