/**
 * POST /api/surge/token  { email, password }  ->  { email, token }
 *
 * Turns a Surge email and password into a Surge token, so the page can
 * publish without the person installing the Surge CLI. The password is sent
 * to Surge once and not kept. If no Surge account has this email, Surge
 * creates one (that is how Surge signs people up).
 * See api/_lib/broker.js for the rules every broker route keeps.
 */
const {
  guard,
  readBody,
  refuse,
  sendJson,
  basic,
} = require("../_lib/broker.js");

module.exports = async function surgeToken(req, res) {
  if (!guard(req, res, ["POST"])) {
    return;
  }
  let input = null;
  try {
    input = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8"));
  } catch (e) {
    refuse(res, 400, "Send JSON with an email and a password");
    return;
  }
  const email = input && typeof input.email === "string" ? input.email : "";
  const password =
    input && typeof input.password === "string" ? input.password : "";
  if (
    !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email) ||
    email.length > 254 ||
    !password ||
    password.length > 1024
  ) {
    refuse(res, 400, "Send JSON with an email and a password");
    return;
  }
  let upstream;
  try {
    upstream = await fetch("https://surge.surge.sh/token", {
      method: "POST",
      headers: {
        authorization: basic(email, password),
        accept: "application/json",
      },
    });
  } catch (e) {
    refuse(res, 502, "Surge could not be reached");
    return;
  }
  let body = null;
  try {
    body = await upstream.json();
  } catch (e) {
    body = null;
  }
  if (!upstream.ok || !body || typeof body.token !== "string") {
    // 401 is a wrong password; Surge says why in its "reason" header
    const reason = upstream.headers.get("reason");
    refuse(
      res,
      upstream.status === 401 ? 401 : 502,
      upstream.status === 401
        ? "Surge did not accept that email and password" +
            (reason ? " (" + reason + ")" : "")
        : "Surge did not return a token",
    );
    return;
  }
  sendJson(res, 200, {
    email: typeof body.email === "string" ? body.email : email,
    token: body.token,
  });
};
