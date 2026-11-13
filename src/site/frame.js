/**
 * Runs in the wrapper the service worker puts around a HAXcms page opened in
 * its own tab, and in the host page: keeps the tab's title and address in
 * step with the page inside the frame, so the tab reads like the page it
 * shows and a reload comes back to the same place.
 */
(function () {
  "use strict";

  const frame = document.getElementById("app");
  const wrapper = globalThis.location.pathname.indexOf("/app/") !== -1;

  function sync() {
    let inner;
    try {
      inner = frame.contentWindow.location;
      if (inner.origin !== globalThis.location.origin) {
        return;
      }
    } catch (e) {
      return; // the frame is showing another site
    }
    const title = frame.contentDocument && frame.contentDocument.title;
    if (title && document.title !== title) {
      document.title = title;
    }
    // only the wrapper shares its address with the page it frames
    if (
      wrapper &&
      inner.href !== globalThis.location.href &&
      inner.pathname.indexOf("/app/") !== -1
    ) {
      globalThis.history.replaceState(null, "", inner.href);
    }
  }

  frame.addEventListener("load", sync);
  setInterval(sync, 1000);
})();
