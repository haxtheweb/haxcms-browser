/**
 * Replays from the HAXcms goggles (haxtheweb/issues#3331).
 *
 * A goggles report in haxtheweb/issues carries a link to this page with a
 * packed replay bundle after #replay=: the reported block (or the whole
 * page), its theme, language and where the piece sits in the page content.
 * Opening it starts HAXcms on a scratch site that holds only that content,
 * opens the page and puts the goggles on, held still on the piece, so a
 * maintainer sees the problem on a site they cannot otherwise reach.
 *
 * Rules this file keeps:
 * - A replay never opens the person's own sites: HAXcms starts with
 *   nothing saved (memory only), so a bundle from an issue cannot reach a
 *   folder, this browser's storage or the cloud, and the scratch site is
 *   gone when the tab closes.
 * - The content goes in through HAXcms's own create-site and add-page
 *   requests, so it is sanitized exactly like a page made in HAXcms.
 * - The bundle is read from the address once and taken out of it, so a
 *   reload does not replay again and the bundle stays out of history.
 * - The bundle comes from a public issue: every field is checked and
 *   anything unexpected is dropped, never passed on as it came.
 *
 * shell.js creates this with HaxcmsReplay({ request, siteTokens,
 * userTokens }), where request sends one request through the Worker as the
 * signed-in local user and resolves { status, json }, siteTokens(site)
 * resolves the headers HAXcms wants on a change to that site, and
 * userTokens() the headers for making a site.
 */
(function () {
  "use strict";

  // "z." + deflate-raw JSON, or "j." + plain JSON, base64url (the goggles'
  // packBundle in haxcms-goggles-report.js)
  const PACKED = /^[zj]\.[A-Za-z0-9_-]+$/;
  // a whole page with its markup stays far below this
  const MAX_PACKED = 4 * 1024 * 1024;
  const MAX_HTML = 2 * 1024 * 1024;
  const SITE = "goggles-replay";

  function fromBase64Url(text) {
    const b = text.replace(/-/g, "+").replace(/_/g, "/");
    const s = globalThis.atob(b + "===".slice((b.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      out[i] = s.charCodeAt(i);
    }
    return out;
  }

  async function unpack(packed) {
    let bytes = fromBase64Url(packed.slice(2));
    if (packed.indexOf("z.") === 0) {
      if (!("DecompressionStream" in globalThis)) {
        throw new Error("this browser cannot open packed replays");
      }
      bytes = new Uint8Array(
        await new globalThis.Response(
          new globalThis.Blob([bytes])
            .stream()
            .pipeThrough(new globalThis.DecompressionStream("deflate-raw")),
        ).arrayBuffer(),
      );
    }
    return JSON.parse(new globalThis.TextDecoder().decode(bytes));
  }

  // only what a replay needs, each field checked; anything else is dropped
  function clean(bundle) {
    if (!bundle || typeof bundle !== "object" || bundle.v !== 1) {
      throw new Error("not a goggles replay");
    }
    const text = (value, pattern, max) => {
      const t = typeof value === "string" ? value.slice(0, max) : "";
      return pattern.test(t) ? t : "";
    };
    const html = typeof bundle.html === "string" ? bundle.html : "";
    if (!html.trim() || html.length > MAX_HTML) {
      throw new Error("the replay has no content to show");
    }
    const mark =
      Array.isArray(bundle.mark) &&
      bundle.mark.length > 0 &&
      bundle.mark.length <= 40 &&
      bundle.mark.every((n) => Number.isInteger(n) && n >= 0 && n < 10000)
        ? bundle.mark
        : [0];
    return {
      scope: bundle.scope === "page" ? "page" : "block",
      tag: text(bundle.tag, /^[a-z][a-z0-9._-]*$/, 100),
      theme: text(bundle.theme, /^[a-z][a-z0-9-]*$/, 100),
      mark: mark,
      html: html,
    };
  }

  globalThis.HaxcmsReplay = function (options) {
    const request = options.request;
    const siteTokens = options.siteTokens;
    const userTokens = options.userTokens;

    // #replay=<packed> on this page's address, read once and taken out of it
    function take() {
      let url;
      try {
        url = new URL(globalThis.location.href);
      } catch (e) {
        return null;
      }
      const hash = url.hash.replace(/^#/, "");
      if (hash.indexOf("replay=") !== 0) {
        return null;
      }
      url.hash = "";
      globalThis.history.replaceState(globalThis.history.state, "", url.href);
      const packed = decodeURIComponent(hash.slice("replay=".length)).trim();
      if (packed.length > MAX_PACKED || !PACKED.test(packed)) {
        return { error: "This replay link is damaged or incomplete." };
      }
      return { packed: packed };
    }

    async function createSite(theme) {
      const headers = Object.assign(
        { "content-type": "application/json" },
        await userTokens(),
      );
      const site = { name: SITE, description: "A goggles replay" };
      if (theme) {
        site.theme = theme;
      }
      return request({
        method: "POST",
        url: "/system/api/v1/sites",
        headers: headers,
        body: new TextEncoder().encode(
          JSON.stringify({
            site: site,
            build: { type: "own", structure: "course", items: null },
          }),
        ).buffer,
      });
    }

    /**
     * Makes the scratch site and its page from a link taken with take().
     * Resolves { site, slug, query, notes } for the address to open, where
     * notes says what could not be replayed as reported (a theme this build
     * does not have).
     */
    async function open(link) {
      if (link.error) {
        throw new Error(link.error);
      }
      const replay = clean(await unpack(link.packed));
      const notes = [];
      let created = await createSite(replay.theme);
      if (created.status === 400 && replay.theme) {
        // a theme only that site has (a custom theme): the default instead
        notes.push(
          'The theme "' +
            replay.theme +
            '" is not in this build, so the replay uses the default theme.',
        );
        created = await createSite("");
      }
      const address = String((created.json && created.json.link) || "");
      const made = /\/_sites\/([^/]+)\/?$/.exec(address);
      if (created.status !== 200 || !made) {
        throw new Error(
          "HAXcms could not make the scratch site (" + created.status + ")",
        );
      }
      const site = decodeURIComponent(made[1]);
      const tokens = await siteTokens(site);
      const added = await request({
        method: "POST",
        url: "/_sites/" + encodeURIComponent(site) + "/x/api/v1/items",
        headers: Object.assign({ "content-type": "application/json" }, tokens),
        body: new TextEncoder().encode(
          JSON.stringify({
            site: { name: site },
            node: {
              title:
                "Replay" +
                (replay.tag ? " of " + replay.tag : "") +
                (replay.scope === "page" ? " (whole page)" : ""),
              contents: replay.html,
            },
          }),
        ).buffer,
      });
      const item = added.json && added.json.data;
      if (added.status !== 200 || !item || !item.slug) {
        throw new Error(
          "HAXcms could not add the replayed page (" + added.status + ")",
        );
      }
      // the goggles' own link: X-ray lens, held still on the marked piece
      const query = new URLSearchParams({
        goggles: "code",
        "goggles-at": replay.mark.join("."),
      });
      return { site: site, slug: item.slug, query: query.toString(), notes };
    }

    return { take: take, open: open, clean: clean, unpack: unpack };
  };
})();
