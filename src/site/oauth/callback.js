/**
 * Where a sign-in provider sends the person back (haxtheweb/issues#3341).
 *
 * The sign-in runs in a popup the HAXcms page opened. This page hands what
 * the provider sent back (the code and state in the query, or Apple's
 * profile in the fragment) to that page, which checks the state and
 * finishes the sign-in, then closes. It only ever talks to pages on its own
 * origin, and it clears the address so the code doesn't stay in history.
 *
 * Some providers' pages cut the popup off from the page that opened it
 * (Cross-Origin-Opener-Policy), so the result also goes out on a
 * BroadcastChannel, which every page of this origin can hear; the page that
 * started the sign-in recognizes it by its state.
 */
(function () {
  "use strict";

  const result = {};
  const query = new URLSearchParams(globalThis.location.search);
  const fragment = new URLSearchParams(
    globalThis.location.hash.replace(/^#/, ""),
  );
  for (const params of [query, fragment]) {
    for (const [key, value] of params) {
      result[key] = value;
    }
  }
  try {
    globalThis.history.replaceState(null, "", globalThis.location.pathname);
  } catch (e) {
    // not important
  }
  const opener = globalThis.opener;
  function say(text) {
    const show = () => {
      document.getElementById("message").textContent = text;
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", show);
    } else {
      show();
    }
  }
  const message = { type: "haxcms-oauth", result };
  let sent = false;
  if (typeof globalThis.BroadcastChannel === "function") {
    const channel = new globalThis.BroadcastChannel("haxcms-oauth");
    channel.postMessage(message);
    channel.close();
    sent = true;
  }
  if (opener && !opener.closed) {
    opener.postMessage(message, globalThis.location.origin);
    sent = true;
  }
  if (!sent) {
    say("This sign-in window was opened from HAXcms. Close it and try again.");
    return;
  }
  say("Signed in. You can close this window.");
  globalThis.setTimeout(() => globalThis.close(), 300);
})();
