/**
 * Things shared to HAX from another app (haxtheweb/issues#3331).
 *
 * Installed, HAX is in the device's share sheet (manifest.webmanifest,
 * share_target). What someone shares (a photo, a file, a link, some text)
 * is put in this browser's storage by the service worker (sw.js), which
 * then opens this page. Here the person sees what arrived, picks a site,
 * and it becomes a new page in that site: files are uploaded to the site's
 * files folder and the page is created through HAXcms's own API, the same
 * requests the editor makes, so content is sanitized and saved exactly as
 * if it had been made in HAXcms.
 *
 * Rules this file keeps:
 * - Nothing is added to a site until the person says so in the dialog.
 * - What was shared is written into the page as text: it is escaped, links
 *   are only made from http(s) addresses, and HAXcms sanitizes the result.
 * - A share waits in this browser until it is added or discarded (the
 *   service worker keeps only the newest few).
 *
 * shell.js creates this with HaxcmsShare({ request, siteTokens, send,
 * isRunning, canSave, openPage, notify }), where request sends one request
 * through the Worker as the signed-in local user and resolves
 * { status, json }, and siteTokens(site) resolves the headers HAXcms wants
 * on a change to that site.
 */
(function () {
  "use strict";

  const scope = new URL("./", globalThis.location.href).pathname;
  const base = globalThis.location.origin + scope;
  // shared with sw.js
  const CACHE = "haxcms-browser-share:" + scope;
  const ITEMS = base + "__share/";

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // an http(s) address, or ""
  function webAddress(text) {
    try {
      const url = new URL(String(text).trim());
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : "";
    } catch (e) {
      return "";
    }
  }

  function withoutExtension(name) {
    return String(name)
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/[-_]+/g, " ")
      .trim();
  }

  function isImage(file) {
    return /^image\//.test(file.type);
  }

  async function inbox() {
    if (!globalThis.caches) {
      return [];
    }
    const cache = await caches.open(CACHE);
    const items = [];
    for (const request of await cache.keys()) {
      if (
        request.url.indexOf(ITEMS) === 0 &&
        /\/item\.json$/.test(request.url)
      ) {
        const saved = await cache.match(request);
        const item = saved ? await saved.json().catch(() => null) : null;
        if (item && item.id) {
          items.push(item);
        }
      }
    }
    return items.sort((a, b) => b.when - a.when);
  }

  async function discard(item) {
    const cache = await caches.open(CACHE);
    for (const file of item.files || []) {
      await cache.delete(file.key);
    }
    await cache.delete(ITEMS + item.id + "/item.json");
  }

  // The new page's content: the text as paragraphs, the link, then each
  // file (an image as an image, anything else as a link to it).
  function pageContent(item, uploaded) {
    const parts = [];
    const link = webAddress(item.url) || webAddress(item.text);
    const text = webAddress(item.text) ? "" : String(item.text || "");
    // a blank line starts a new paragraph; other line ends are line breaks
    let lines = [];
    for (const line of text.split("\n").concat("")) {
      if (line.trim()) {
        lines.push(escapeHtml(line.trim()));
      } else if (lines.length) {
        parts.push("<p>" + lines.join("<br>") + "</p>");
        lines = [];
      }
    }
    if (link) {
      parts.push(
        '<p><a href="' +
          escapeHtml(link) +
          '">' +
          escapeHtml(link) +
          "</a></p>",
      );
    }
    for (const file of uploaded) {
      const address = escapeHtml(file.path);
      if (file.image) {
        const size =
          file.width && file.height
            ? ' width="' +
              Number(file.width) +
              '" height="' +
              Number(file.height) +
              '"'
            : "";
        parts.push(
          '<p><img src="' +
            address +
            '" alt="' +
            escapeHtml(file.description) +
            '"' +
            size +
            "></p>",
        );
      } else {
        parts.push(
          '<p><a href="' + address + '">' + escapeHtml(file.name) + "</a></p>",
        );
      }
    }
    return parts.join("\n") || "<p></p>";
  }

  globalThis.HaxcmsShare = function HaxcmsShare(options) {
    const request = options.request;
    const send = options.send;
    const button = byId("share-button");
    const dialog = byId("share");
    const form = byId("share-form");
    const list = byId("share-items");
    const none = byId("share-none");
    const fields = byId("share-fields");
    const siteSelect = byId("share-site");
    const pageInput = byId("share-page");
    const descriptions = byId("share-descriptions");
    const status = byId("share-status");
    const submit = byId("share-submit");
    const later = byId("share-later");
    const discardButton = byId("share-discard");

    let items = [];
    let current = null;
    let busy = false;

    function setStatus(text, state) {
      status.textContent = text;
      status.dataset.state = state || "";
    }

    function setBusy(value) {
      busy = value;
      submit.disabled = value;
      later.disabled = value;
      discardButton.disabled = value;
    }

    async function refresh() {
      items = await inbox().catch(() => []);
      button.hidden = !(items.length && options.isRunning());
      button.textContent =
        "Shared with HAX" + (items.length > 1 ? " (" + items.length + ")" : "");
      return items;
    }

    function describe(item) {
      list.textContent = "";
      const add = (text) => {
        const entry = document.createElement("li");
        entry.textContent = text;
        list.append(entry);
      };
      if (item.title) {
        add(item.title);
      }
      if (item.text && item.text !== item.title) {
        add(item.text.length > 240 ? item.text.slice(0, 240) + "…" : item.text);
      }
      if (item.url && item.url !== item.text) {
        add(item.url);
      }
      for (const file of item.files || []) {
        add(file.name);
      }
      descriptions.textContent = "";
      (item.files || []).forEach((file, index) => {
        if (!isImage(file)) {
          return;
        }
        const label = document.createElement("label");
        label.htmlFor = "share-description-" + index;
        label.textContent = 'Describe the image "' + file.name + '"';
        const input = document.createElement("input");
        input.type = "text";
        input.id = "share-description-" + index;
        input.dataset.file = String(index);
        input.maxLength = 300;
        input.placeholder = "What it shows, for people who cannot see it";
        descriptions.append(label, input);
      });
    }

    async function open(id) {
      await refresh();
      current = items.find((item) => item.id === id) || items[0] || null;
      setStatus("", "");
      setBusy(false);
      if (!current) {
        return;
      }
      describe(current);
      let sites = [];
      try {
        sites = await send("listSites", {});
      } catch (e) {
        sites = [];
      }
      siteSelect.textContent = "";
      for (const site of sites) {
        const option = document.createElement("option");
        option.value = site.name;
        option.textContent =
          site.title === site.name
            ? site.name
            : site.title + " (" + site.name + ")";
        siteSelect.append(option);
      }
      pageInput.value =
        current.title ||
        (current.files && current.files[0]
          ? withoutExtension(current.files[0].name)
          : "") ||
        "Shared with HAX";
      let problem = "";
      if (!options.canSave()) {
        problem =
          "This window is not saving sites (HAX may be open in another window, which is the one saving). Add it from there: it will be waiting under Shared with HAX.";
      } else if (!sites.length) {
        problem =
          "There are no sites yet. Make one from the dashboard, then come back to this with Shared with HAX in the bar.";
      }
      none.textContent = problem;
      none.hidden = !problem;
      fields.hidden = !!problem;
      submit.hidden = !!problem;
      if (!dialog.open) {
        dialog.showModal();
      }
      (problem ? later : siteSelect).focus();
    }

    async function upload(site, tokens, file, description) {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(file.key);
      if (!saved) {
        throw new Error('"' + file.name + '" is no longer in this browser');
      }
      const data = new FormData();
      data.append(
        "file-upload",
        new File([await saved.blob()], file.name, { type: file.type }),
      );
      // the browser writes the multipart body and its boundary
      const packed = new Response(data);
      const answer = await request({
        method: "POST",
        url: "/_sites/" + encodeURIComponent(site) + "/x/api/v1/files",
        headers: Object.assign(
          { "content-type": packed.headers.get("content-type") },
          tokens,
        ),
        body: await packed.arrayBuffer(),
      });
      const stored = answer.json && answer.json.data && answer.json.data.file;
      if (answer.status !== 200 || !stored || !stored.path) {
        throw new Error(
          '"' + file.name + '" could not be added (' + answer.status + ")",
        );
      }
      return {
        path: stored.path,
        name: stored.name || file.name,
        image: isImage(file),
        width: stored.width,
        height: stored.height,
        description: description || withoutExtension(file.name),
      };
    }

    async function add(event) {
      event.preventDefault();
      if (busy || !current) {
        return;
      }
      const site = siteSelect.value;
      const title = pageInput.value.trim();
      if (!site || !title) {
        setStatus("Pick a site and give the page a title.", "error");
        (site ? pageInput : siteSelect).focus();
        return;
      }
      const item = current;
      setBusy(true);
      try {
        setStatus("Adding it to " + site + "…", "");
        // the same tokens the editor works with, for this site
        const tokens = await options.siteTokens(site);
        const uploaded = [];
        const files = item.files || [];
        for (let index = 0; index < files.length; index++) {
          const input = descriptions.querySelector(
            'input[data-file="' + index + '"]',
          );
          uploaded.push(
            await upload(
              site,
              tokens,
              files[index],
              input ? input.value.trim() : "",
            ),
          );
        }
        const created = await request({
          method: "POST",
          url: "/_sites/" + encodeURIComponent(site) + "/x/api/v1/items",
          headers: Object.assign(
            { "content-type": "application/json" },
            tokens,
          ),
          body: new TextEncoder().encode(
            JSON.stringify({
              site: { name: site },
              node: { title, contents: pageContent(item, uploaded) },
            }),
          ).buffer,
        });
        if (created.status !== 200) {
          throw new Error(
            "the page could not be created (" + created.status + ")",
          );
        }
        await discard(item);
        await refresh();
        dialog.close();
        const made = (created.json && created.json.data) || {};
        options.openPage(site, made.slug || "");
        options.notify('Added "' + title + '" to ' + site + ".");
      } catch (error) {
        console.error("[haxcms-browser] share", error);
        setStatus(
          "That did not work: " +
            String((error && error.message) || error) +
            ". What you shared is still here.",
          "error",
        );
      } finally {
        setBusy(false);
      }
    }

    button.addEventListener("click", () => {
      open().catch((error) => console.error("[haxcms-browser] share", error));
    });
    form.addEventListener("submit", add);
    later.addEventListener("click", () => dialog.close());
    discardButton.addEventListener("click", () => {
      if (!current || busy) {
        return;
      }
      discard(current)
        .then(refresh)
        .then(() => dialog.close());
    });
    dialog.addEventListener("cancel", (event) => {
      if (busy) {
        event.preventDefault();
      }
    });
    // another window of HAX received a share: show it here too
    if (globalThis.BroadcastChannel) {
      const channel = new BroadcastChannel("haxcms-browser:share");
      channel.onmessage = () => {
        refresh();
      };
      options.announce = () => channel.postMessage("changed");
    }

    return {
      // called when HAXcms is running (and again after a restart)
      async start() {
        const url = new URL(globalThis.location.href);
        const id = url.searchParams.get("share");
        if (id !== null) {
          // the address should not carry the share once it has been seen
          url.searchParams.delete("share");
          globalThis.history.replaceState(null, "", url.href);
          if (options.announce) {
            options.announce();
          }
        }
        await refresh();
        if (id !== null && items.length) {
          await open(id);
        }
      },
      hide() {
        button.hidden = true;
      },
    };
  };
})();
