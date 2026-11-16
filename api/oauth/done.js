/**
 * GET /api/oauth/done: the last stop of the sign-in popup
 * (haxtheweb/issues#3341).
 *
 * A fixed page: it reads the result /api/oauth/callback put in the address
 * fragment (the page's nonce and the sealed result, or an error), clears
 * the address, hands the result to the HAXcms page on this origin and
 * closes. Nothing from the request is ever written into the page.
 *
 * Some providers cut the popup off from the page that opened it
 * (Cross-Origin-Opener-Policy), so the result also goes out on a
 * BroadcastChannel. Only the page that started the sign-in has the key to
 * open the sealed result.
 */
const crypto = require("node:crypto");

const SCRIPT = `(function () {
  "use strict";
  var fragment = new URLSearchParams(globalThis.location.hash.slice(1));
  try {
    globalThis.history.replaceState(null, "", globalThis.location.pathname);
  } catch (e) {}
  var message = {
    type: "haxcms-oauth",
    result: {
      nonce: fragment.get("n") || "",
      box: fragment.get("r") || "",
      error: fragment.get("e") || ""
    }
  };
  var sent = false;
  if (typeof globalThis.BroadcastChannel === "function") {
    var channel = new globalThis.BroadcastChannel("haxcms-oauth");
    channel.postMessage(message);
    channel.close();
    sent = true;
  }
  var opener = globalThis.opener;
  if (opener && !opener.closed) {
    opener.postMessage(message, globalThis.location.origin);
    sent = true;
  }
  document.getElementById("message").textContent = sent
    ? "You can close this window."
    : "This sign-in window was opened from HAXcms. Close it and try again.";
  if (sent) {
    globalThis.setTimeout(function () {
      globalThis.close();
    }, 300);
  }
})();`;

const HASH = crypto.createHash("sha256").update(SCRIPT).digest("base64");

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signing in to HAXcms</title>
  </head>
  <body>
    <p id="message">Finishing your sign-in…</p>
    <script>${SCRIPT}</script>
  </body>
</html>
`;

module.exports = function oauthDone(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'sha256-" +
      HASH +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.end(PAGE);
};
