/**
 * Open in HAX, for site generators (haxtheweb/issues#3405).
 *
 * Load this on a page that builds a HAXcms site in the browser, and its
 * people can open what they made straight in HAX, with no download:
 *
 *   <script type="module" src="https://browser.hax.cloud/open-in-hax.js"></script>
 *   <open-in-hax site-title="My homepage" generator="My generator"></open-in-hax>
 *   <script>
 *     document.querySelector("open-in-hax").getSite = async () => zipBlob;
 *   </script>
 *
 * or, without the element, from your own button's click handler:
 *
 *   import { openInHax } from "https://browser.hax.cloud/open-in-hax.js";
 *   const result = await openInHax({ getSite, title, generator });
 *
 * getSite resolves the site as a HAXcms site zip (a Blob or ArrayBuffer):
 * what HAXcms's Download site gives, site.json with pages/ and files/ beside
 * it. The tab it opens asks the person before it takes anything; the zip is
 * then passed tab to tab with postMessage and never reaches a server.
 * Results: { ok: true, name } or { ok: false, error } with error one of
 * declined, too-large, not-a-zip, invalid-site, timeout, import-failed,
 * popup-blocked, closed.
 *
 * Check a site before offering the button with hax-site-check.js, served
 * beside this file: the importer's own rules, returning every problem
 * (haxtheweb/issues#3426):
 *
 *   import "https://browser.hax.cloud/hax-site-check.js";
 *   const { ok, problems } = globalThis.HAXSiteCheck.checkHaxSite({
 *     siteJson,              // site.json, decoded or as text
 *     files: ["site.json", "pages/home/index.html"], // paths in the zip
 *     zipBytes: zipBlob.size,
 *   });
 *
 * The HAX it opens is the one this file was loaded from, so a self-hosted
 * copy of browser.hax.cloud works the same way. No dependencies.
 */
const PROTOCOL = "hax-handoff";
const VERSION = 1;
const WAIT_MS = 5 * 60 * 1000;
const DEFAULT_TARGET = new URL("./?handoff=1", import.meta.url).href;

function message(type, fields) {
  return Object.assign({ protocol: PROTOCOL, version: VERSION, type }, fields);
}

function isMessage(data, type) {
  return (
    !!data &&
    typeof data === "object" &&
    data.protocol === PROTOCOL &&
    data.version === VERSION &&
    data.type === type
  );
}

/**
 * Open HAX in a new tab and hand it the site. Call it from a click (or other
 * user action), or the browser blocks the new tab.
 * @param {Object} options
 * @param {() => Promise<Blob|ArrayBuffer>|Blob|ArrayBuffer} options.getSite the site zip
 * @param {string} [options.title] the site's title, shown when HAX asks
 * @param {{name: string, url: string}|string} [options.generator] who made it
 * @param {string} [options.target] the HAX to open (default: where this file came from)
 * @returns {Promise<{ok: boolean, name?: string, error?: string}>}
 */
export function openInHax(options) {
  const opts = options || {};
  const target = new URL(opts.target || DEFAULT_TARGET);
  if (!target.searchParams.has("handoff")) {
    target.searchParams.set("handoff", "1");
  }
  const generator =
    typeof opts.generator === "string"
      ? { name: opts.generator, url: globalThis.location.href }
      : Object.assign(
          { name: globalThis.document.title, url: globalThis.location.href },
          opts.generator || {},
        );
  // opened now, inside the click, so it is not blocked
  const tab = globalThis.open(target.href, "_blank");
  if (!tab) {
    return Promise.resolve({ ok: false, error: "popup-blocked" });
  }
  const site = Promise.resolve()
    .then(() => opts.getSite())
    .then((data) => (data instanceof Blob ? data : new Blob([data])));

  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(
      () => end({ ok: false, error: "timeout" }),
      WAIT_MS,
    );
    const watch = setInterval(() => {
      if (tab.closed) {
        end({ ok: false, error: "closed" });
      }
    }, 1000);

    function end(result) {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      globalThis.removeEventListener("message", onMessage);
      resolve(result);
    }

    function send(data) {
      // only ever to the HAX this was meant for
      tab.postMessage(data, target.origin);
    }

    async function onMessage(event) {
      if (event.source !== tab || event.origin !== target.origin) {
        return;
      }
      const data = event.data;
      if (isMessage(data, "ready")) {
        if (
          !Array.isArray(data.versions) ||
          data.versions.indexOf(VERSION) === -1
        ) {
          end({ ok: false, error: "import-failed" });
          return;
        }
        let blob;
        try {
          blob = await site;
        } catch (error) {
          console.warn("[open-in-hax] getSite", error);
          end({ ok: false, error: "not-a-zip" });
          return;
        }
        send(
          message("offer", {
            generator: {
              name: String(generator.name || ""),
              url: String(generator.url || ""),
            },
            title: String(opts.title || ""),
            format: "haxcms-zip",
            size: blob.size,
          }),
        );
      } else if (isMessage(data, "consent")) {
        if (data.allowed === true) {
          send(message("payload", { data: await site }));
        }
      } else if (isMessage(data, "result")) {
        end(
          data.ok === true
            ? { ok: true, name: String(data.name || "") }
            : { ok: false, error: String(data.error || "import-failed") },
        );
      }
    }

    globalThis.addEventListener("message", onMessage);
  });
}

/**
 * <open-in-hax site-title="" generator="" target="">: a button that runs
 * openInHax with its getSite property, and fires "open-in-hax-result"
 * (detail: the result). Its text can be replaced through the default slot.
 */
export class OpenInHax extends HTMLElement {
  constructor() {
    super();
    this.getSite = null;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>:host{display:inline-block}button{font:inherit;cursor:pointer;" +
      "padding:.5em 1em;border-radius:4px;border:2px solid currentColor;" +
      "background:#001e44;color:#fff}button:focus-visible{outline:3px solid " +
      "#3e98d3;outline-offset:2px}button[disabled]{opacity:.6;cursor:wait}" +
      "</style><button type='button' part='button'><slot>Open in HAX</slot></button>";
    this._button = root.querySelector("button");
    this._button.addEventListener("click", () => this.open());
  }

  /** Runs the handoff; resolves its result. */
  async open() {
    if (typeof this.getSite !== "function") {
      throw new Error("open-in-hax needs a getSite function");
    }
    this._button.disabled = true;
    this._button.setAttribute("aria-busy", "true");
    let result;
    try {
      result = await openInHax({
        getSite: this.getSite,
        title: this.getAttribute("site-title") || "",
        generator: this.getAttribute("generator") || undefined,
        target: this.getAttribute("target") || undefined,
      });
    } finally {
      this._button.disabled = false;
      this._button.removeAttribute("aria-busy");
    }
    this.dispatchEvent(
      new CustomEvent("open-in-hax-result", {
        detail: result,
        bubbles: true,
        composed: true,
      }),
    );
    return result;
  }
}

if (
  globalThis.customElements &&
  !globalThis.customElements.get("open-in-hax")
) {
  globalThis.customElements.define("open-in-hax", OpenInHax);
}
