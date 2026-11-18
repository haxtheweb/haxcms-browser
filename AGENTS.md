# AGENTS.md

Instructions for AI coding agents working in haxcms-browser: haxcms-nodejs bundled to run in a browser Worker ([haxtheweb/issues#3331](https://github.com/haxtheweb/issues/issues/3331)).

## Ecosystem context (maintained in PRAW)

Shared HAX ecosystem guidance (repo map, pillars, rules, scoped rules, skills) lives in one place,
https://github.com/haxtheweb/praw, and is read from there instead of being copied into each repo:

- Always-on rules and ecosystem index: <https://github.com/haxtheweb/praw/blob/main/WARP.md>
- Rule registry, by Rule ID: <https://github.com/haxtheweb/praw/blob/main/RULES.md>
- Scoped rules: [HAXcms backends](https://github.com/haxtheweb/praw/blob/main/haxcms/WARP.md), [webcomponents](https://github.com/haxtheweb/praw/blob/main/webcomponents/WARP.md)
- Machine-readable index: <https://raw.githubusercontent.com/haxtheweb/praw/main/llms.txt>
- Work queue: <https://github.com/haxtheweb/issues> (`gh issue list --repo haxtheweb/issues`). Issues are filed there, not in this repo.

## Rules for this repo

- **Do not fork haxcms-nodejs logic.** Behavior comes from bundling haxcms-nodejs as-is. If something has to change for the browser, change it in haxcms-nodejs as a behavior-neutral seam (and mirror any API-visible change in haxcms-php), then consume it here.
- **Parity is the test.** Anything the runtime does must give the same result as haxcms-nodejs on Node. Add cases to `test/scenario.cjs` rather than browser-only tests where possible.
- **saveOutline / outline-designer saving is mission-critical.** Changes that touch saving must keep success and failure behavior identical, including "a failed save does not write".
- **Never weaken content sanitizing.** Sites made here get deployed elsewhere. If a sanitize dependency (jsdom) can't run, the feature stays unavailable until a replacement produces the same output.
- **Licenses.** The bundle ships dependency code. Only Apache-2.0-compatible permissive licenses (MIT, BSD, ISC, Apache-2.0, ...). No LGPL/GPL/MPL packages in the runtime, even if a review entry would let the check pass.
- **Test against haxcms-nodejs main**, not only the published package (`HAXCMS_NODEJS_SRC`). When a change needs haxcms-nodejs changed too, use the same branch name in both repos: CI here builds against that branch until it lands.
- **Saving.** A request that can change something is answered only after its changes are written to storage; if that fails, the response is an error (`BROWSER_STORAGE_WRITE_FAILED`), never a success. A failed write must leave the previous file intact. Only regular files and folders under the sites folder are written out, and nothing outside the user's chosen folder is touched.
- **Relay rules (`src/site/sw.js`).** Navigations are relayed for GET only; a write is relayed only from a page inside the session's mount; relayed requests never reach the network. Keep these when changing the service worker. The site must work under a path (GitHub Pages) and at the root of a domain (Vercel): never assume either. Requests from a blank frame (`about:blank`) are not seen by the service worker in Chrome, so anything loaded from one needs its real static address.
- **Offline copy (`src/site/offline.js`, `src/site/sw.js`).** Nothing is cached until the person installs the app or asks for offline use; without a copy the service worker fetches every static file from the web server. A copy is one whole build (`offline-manifest.json`), written only by the host page, never added to as pages load, and never changed in place: an update is saved beside it and swapped in when complete. A save that stops part way keeps the files that arrived whole and carries on from them next time, but is never served until its meta record is written; only one window saves at a time (a Web Lock). Do not say HAX works offline before a copy is complete. Updates are offered in a notice, not taken silently. `reset.html` is never handled by the service worker and needs no other file. Relayed requests and their answers are never cached. Saving, updating or removing the copy never touches sites. The browser updates `sw.js` on its own schedule, so a new `sw.js` must keep working with the host page inside any copy saved under the current `OFFLINE_FORMAT`; when it cannot, or the layout of a copy changes, bump `OFFLINE_FORMAT` in `sw.js`, `offline.js` and `scripts/offline-manifest.mjs` together (every browser then drops its copy and loads from the web). A file added to `src/site/` that the host page loads goes in `HOST_FILES` in `sw.js`, or it will not be served offline.
- **Share target (`src/site/share.js`).** A share is only held in the browser until the person adds or discards it; nothing reaches a site without their confirmation. Shared text is escaped, links are made from http(s) addresses only, and the page is created through HAXcms's own API (never by writing files), so sanitizing is haxcms-nodejs's.
- **Publish broker (`api/`).** Stateless: no storage, no logging of bodies, passwords, tokens or secrets. Routes that reach a publishing service are rate limited per caller, and the Surge token route per account too (`api/_lib/limit.js`): the counts are digests held in memory until their window ends, per function instance, so a deployment that needs a global quota adds a firewall rate limit rule in front of `/api/`. The host page and the broker are served with `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `X-Frame-Options: SAMEORIGIN` (`vercel.json`); no Content-Security-Policy is set, because the HAXcms frame needs its scripts to run. Only its own origin (or `HAX_BROKER_ALLOWED_ORIGINS`) may call it; outbound requests go only to fixed addresses written in the code (Surge, each provider's token endpoint in `api/_lib/providers.js`), with caller input validated and used as a path segment or a key into that list, never a host. A sign-in is finished only at `/api/oauth/callback`, when its state matches the signed, HttpOnly cookie `/api/oauth/start` set in the same browser (`api/_lib/state.js`, `HAX_OAUTH_STATE_SECRET`); the result goes back to the page sealed with the key that page made, through `/api/oauth/done`, a fixed page that never writes request data into its HTML. Secrets come from environment variables (`HAX_OAUTH_<ID>_*`, see `docs/providers.md`) and never reach the page.
- **Publishing** packs the same files the HAX CLI publishes (`src/runtime/publish.cjs`) and never changes the site. Hosts that accept browser requests (GitHub, GitLab, Codeberg, Netlify, Vercel) are called straight from the page (`src/site/publish-hosts.js`), not through the broker.
- **Cloud storage** (`src/runtime/remote.cjs`) is a directory handle for `storage.cjs`, so the Saving rules above hold for it too; each backend stays inside its own HAXcms folder and removes to the service's trash where it has one. Tokens stay in the tab (memory and sessionStorage), never localStorage; a WebDAV app password is never stored.
- No optional chaining (`?.`); use `globalThis`, not `window` (the runtime is a Worker).
- **Every engine, not only Chrome.** The demo must start and save in WebKit (Safari, every iOS browser) and Firefox. Do not rely on something only Chromium has without a fallback: a directory handle cannot be sent to a Worker in WebKit, `createWritable` is not everywhere, `showDirectoryPicker` is Chromium only, and packages that read V8's stack API fail to load elsewhere. `test/engines/` runs in CI in both engines; a change to start-up, storage, the Worker protocol or the bundle that should hold in every engine gets a case there.

## Commands

```bash
npm ci
export HAXCMS_NODEJS_SRC=/path/to/haxcms-nodejs/src
npm run build
npm test            # headless Chrome; PUPPETEER_EXECUTABLE_PATH if not /usr/bin/google-chrome
npm run test:engines  # the same demo in WebKit and Firefox (once: npx playwright-core install webkit firefox)
npm run precheck    # run before every push or PR; precheck:fix auto-fixes
npm run lint:security
```

## Layout

- `scripts/build.mjs`: the esbuild bundle (built-in swaps, unavailable-package stubs, data snapshot)
- `src/runtime/worker.cjs`: the Worker and its message protocol
- `src/runtime/storage.cjs`: keeps the sites folder in the volume and a directory handle (the user's folder or browser storage) the same: load, flush, refresh
- `src/runtime/shims/`: Node built-ins the Worker provides itself (fs → memfs, http → requests dispatched to the Express app, process, os, crypto with scrypt / KeyObject / randomInt, net address checks, tty, async_hooks) and `sharp.cjs`, the stand-in for sharp built on the browser's image decoding
- `src/runtime/publish.cjs`: packs a site for a static host (file selection matching `hax site site:surge`, ustar tarball, gzip)
- `src/runtime/remote.cjs`: cloud storage as a directory handle (Google Drive, OneDrive, Dropbox, Box, WebDAV)
- `api/`: the broker, Vercel functions deployed with the site (`status.js`, `surge/token.js`, `surge/deploy.js`, `oauth/providers.js`, `oauth/start.js`, `oauth/callback.js`, `oauth/done.js`, `oauth/refresh.js`; shared rules in `_lib/broker.js`, the providers in `_lib/providers.js`, token exchange in `_lib/oauth.js`, the sign-in cookie and sealing in `_lib/state.js`, request limits in `_lib/limit.js`)
- `docs/providers.md`: registering each service's OAuth app and the environment variables
- `src/site/`: the hosted demo. `index.html` + `shell.js` (host page: owns the Worker, signs in, keeps the session's cookies, answers relayed requests), `publish.js` (the Publish dialog), `publish-hosts.js` (GitHub Pages, GitLab Pages, Codeberg Pages, Netlify, Vercel), `auth.js` (sign-in: popup, sealed result, tokens), `accounts.js` (Sign in and Save to the cloud dialogs), `sw.js` (service worker: relays HAXcms requests to the host page, serves front-end build files from the static copy or the offline copy, receives shares), `frame.js` (title and address sync), `manifest.webmanifest` + icons (the installable app), `offline.js` (saves, updates and removes the offline copy; install button), `share.js` (things shared to the installed app), `reset.html` (removes the service worker and offline copy)
- `scripts/build-site.mjs`: assembles the static site (`npm run build:site`), ending with `scripts/offline-manifest.mjs` (the list an offline copy is made from); `scripts/serve-site.mjs` serves it like GitHub Pages (`npm run serve`)
- `.github/workflows/pages.yml`: publishes the demo to GitHub Pages from `main`
- `scripts/start.mjs`: `npm start`, builds the site if missing and serves it
- `scripts/build-hosted.mjs` + `vercel.json`: the same build in one step for hosts that build from the repository (`npm run build:hosted`)
- `test/`: parity scenario and Node runner (`parity.test.mjs`), the hosted demo end to end (`site.test.mjs`, including Publish through a stand-in broker and Surge), the packer (`publish.test.mjs`), the broker (`broker.test.mjs`, `oauth.test.mjs`), cloud storage (`remote.test.mjs`), the publish hosts (`publish-hosts.test.mjs`), at the root of a domain (`root.test.mjs`), the storage layer against a stand-in folder (`storage.test.mjs`), and the installable app: offline copy, update notice, reset and share target (`offline.test.mjs`); `test/engines/engines.test.mjs` (not part of `npm test`) runs start, save in the browser and reload in WebKit and Firefox with Playwright

## Pull requests

- Title: `[haxcms-browser] <Descriptive title>`
- Run `npm run precheck`, `npm run lint:security` and `npm test` (against haxcms-nodejs main) before pushing.
- Reference the issue in haxtheweb/issues in the PR body.
