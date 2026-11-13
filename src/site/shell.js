/**
 * Host page for HAXcms in the browser (haxtheweb/issues#3331).
 *
 * This page owns the Worker that runs haxcms-nodejs, and shows HAXcms in an
 * iframe mounted at ./app/<session>/. The service worker (sw.js) sends every
 * request those iframe pages make back to this page, which passes it to the
 * Worker and returns the answer. Because the Worker belongs to this page,
 * HAXcms keeps running while the iframe moves between the dashboard and
 * sites; reloading or closing this page ends the session and its sites.
 */
(function () {
  "use strict";

  const statusText = document.getElementById("status");
  const dot = document.getElementById("dot");
  const frame = document.getElementById("app");
  const message = document.getElementById("message");
  const detailsButton = document.getElementById("details-button");
  const details = document.getElementById("details");
  const detailsList = document.getElementById("details-list");

  const scope = new URL("./", globalThis.location.href).pathname;
  // one random id per host page, so two tabs never answer for each other
  const session = Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(8)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const mount = scope + "app/" + session + "/";

  function setStatus(text, state) {
    statusText.textContent = text;
    dot.dataset.state = state || "";
  }

  function addDetail(label, value) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    detailsList.append(term, description);
  }

  function fail(title, error) {
    setStatus("HAXcms could not start", "error");
    frame.hidden = true;
    message.hidden = false;
    message.textContent = "";
    const heading = document.createElement("h1");
    heading.textContent = title;
    const text = document.createElement("pre");
    text.textContent = String((error && error.stack) || error || "");
    message.append(heading, text);
  }

  // what the runtime could not load, as the features people know
  const FEATURES = {
    "git-interface": "revisions (git history)",
    sharp: "image resizing",
    "puppeteer-core": "PDF export",
    "html-to-docx": "Word export",
    "epub-gen-memory": "EPUB export",
    mammoth: "Word import",
    unpdf: "PDF import",
    "text-readability": "readability scores",
  };

  function unavailableFeatures(names) {
    const features = (names || [])
      .filter((name) => Object.prototype.hasOwnProperty.call(FEATURES, name))
      .map((name) => FEATURES[name]);
    return features.length ? features.join(", ") : "nothing";
  }

  detailsButton.addEventListener("click", () => {
    details.hidden = !details.hidden;
    detailsButton.setAttribute("aria-expanded", String(!details.hidden));
  });

  // --- the Worker that runs haxcms-nodejs ------------------------------
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function send(type, args, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id, type }, args), transfer || []);
    });
  }

  function startWorker() {
    worker = new Worker("./haxcms-worker.js");
    worker.onmessage = (event) => {
      const data = event.data || {};
      const waiting = pending.get(data.id);
      if (!waiting) {
        return;
      }
      pending.delete(data.id);
      if (data.ok) {
        waiting.resolve(data.result);
      } else {
        waiting.reject(new Error(data.error));
      }
    };
    worker.onerror = (event) => {
      fail("The HAXcms runtime stopped", event.message);
    };
  }

  // --- cookies -----------------------------------------------------------
  // A service worker cannot set real cookies on the responses it builds, and
  // HAXcms keeps the signed-in session in one. So this page keeps the
  // session's cookies itself, in memory: it remembers what the runtime sets
  // and sends it back on later requests, as a browser would.
  const cookies = new Map();

  function rememberCookies(headers) {
    const setCookie = headers && headers["set-cookie"];
    if (!setCookie) {
      return;
    }
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const parts = String(line).split(";");
      const pair = parts[0];
      const equals = pair.indexOf("=");
      if (equals < 1) {
        continue;
      }
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      let expired = value === "";
      for (const attribute of parts.slice(1)) {
        const [key, attributeValue] = attribute.trim().split("=");
        if (/^max-age$/i.test(key) && Number(attributeValue) <= 0) {
          expired = true;
        }
        if (
          /^expires$/i.test(key) &&
          Date.parse(attributeValue) <= Date.now()
        ) {
          expired = true;
        }
      }
      if (expired) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
    delete headers["set-cookie"];
  }

  function cookieHeader() {
    return Array.from(cookies, ([name, value]) => name + "=" + value).join(
      "; ",
    );
  }

  // --- requests relayed by the service worker --------------------------
  function onServiceWorkerMessage(event) {
    // only this origin's service worker can reach this listener
    if (event.origin && event.origin !== globalThis.location.origin) {
      return;
    }
    const data = event.data || {};
    if (data.type !== "haxcms-request" || data.session !== session) {
      return; // another tab's session: that tab answers
    }
    const port = event.ports[0];
    port.postMessage({ ack: true });
    const request = Object.assign({}, data.request, { binary: true });
    request.headers = Object.assign({}, request.headers);
    if (cookies.size) {
      request.headers.cookie = cookieHeader();
    }
    send("request", request, request.body ? [request.body] : [])
      .then((response) => {
        rememberCookies(response.headers);
        port.postMessage({ response }, response.body ? [response.body] : []);
      })
      .catch((error) => {
        console.error("[haxcms-browser]", error);
        port.postMessage({ error: String((error && error.message) || error) });
      });
  }

  async function registerServiceWorker() {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
    });
    await navigator.serviceWorker.ready;
    return registration;
  }

  async function loadJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(url + " answered " + response.status);
    }
    return response.json();
  }

  async function start() {
    if (!("serviceWorker" in navigator) || !globalThis.Worker) {
      fail(
        "This browser can't run HAXcms in a tab",
        "It needs service workers and web workers. Private windows in some browsers turn service workers off.",
      );
      return;
    }
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    const began = performance.now();
    const [, snapshot, version] = await Promise.all([
      registerServiceWorker(),
      loadJson("./haxcms-snapshot.json"),
      loadJson("./version.json").catch(() => ({})),
    ]);
    startWorker();
    const booted = await send("boot", {
      snapshot,
      root: "/haxcms",
      basePath: mount,
    });
    // one local user, so sign in for them: HAXcms then opens signed in
    const signedIn = await send("signIn", {});
    if (signedIn.status !== 200) {
      throw new Error(
        "could not sign in the local user (" + signedIn.status + ")",
      );
    }
    rememberCookies(signedIn.headers);
    const seconds = ((performance.now() - began) / 1000).toFixed(1);
    addDetail(
      "Running",
      "haxcms-nodejs in this browser tab (" +
        booted.mode +
        " mode), started in " +
        seconds +
        " s",
    );
    addDetail("Saving to", "This tab's memory only");
    addDetail("Not available here", unavailableFeatures(booted.unavailable));
    addDetail(
      "Build",
      "haxcms-browser " +
        (version.haxcmsBrowser || "local") +
        ", haxcms-nodejs " +
        (version.haxcmsNodejs || "local") +
        (version.built ? ", " + version.built : ""),
    );
    frame.addEventListener("load", () => {
      setStatus("HAXcms is running in your browser", "ready");
    });
    frame.hidden = false;
    frame.src = mount;
  }

  // closing or reloading ends the session: say so before it happens
  globalThis.addEventListener("beforeunload", (event) => {
    if (worker && !frame.hidden) {
      event.preventDefault();
    }
  });

  start().catch((error) => fail("HAXcms could not start", error));
})();
