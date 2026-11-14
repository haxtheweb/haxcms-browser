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
- **Publish broker (`api/`).** Stateless: no storage, no logging of bodies, passwords or tokens. Only its own origin (or `HAX_BROKER_ALLOWED_ORIGINS`) may call it; outbound requests go only to the service's fixed address, with caller input validated and used as a path segment, never a host. Publishing packs the same files the HAX CLI publishes (`src/runtime/publish.cjs`) and never changes the site.
- No optional chaining (`?.`); use `globalThis`, not `window` (the runtime is a Worker).

## Commands

```bash
npm ci
export HAXCMS_NODEJS_SRC=/path/to/haxcms-nodejs/src
npm run build
npm test            # headless Chrome; PUPPETEER_EXECUTABLE_PATH if not /usr/bin/google-chrome
npm run precheck    # run before every push or PR; precheck:fix auto-fixes
npm run lint:security
```

## Layout

- `scripts/build.mjs`: the esbuild bundle (built-in swaps, unavailable-package stubs, data snapshot)
- `src/runtime/worker.cjs`: the Worker and its message protocol
- `src/runtime/storage.cjs`: keeps the sites folder in the volume and a directory handle (the user's folder or browser storage) the same: load, flush, refresh
- `src/runtime/shims/`: Node built-ins the Worker provides itself (fs → memfs, http → requests dispatched to the Express app, process, os, crypto with scrypt / KeyObject / randomInt, net address checks, tty, async_hooks) and `sharp.cjs`, the stand-in for sharp built on the browser's image decoding
- `src/runtime/publish.cjs`: packs a site for a static host (file selection matching `hax site site:surge`, ustar tarball, gzip)
- `api/`: the publish broker, Vercel functions deployed with the site (`status.js`, `surge/token.js`, `surge/deploy.js`; shared rules in `_lib/broker.js`)
- `src/site/`: the hosted demo. `index.html` + `shell.js` (host page: owns the Worker, signs in, keeps the session's cookies, answers relayed requests), `publish.js` (the Publish dialog), `sw.js` (service worker: relays HAXcms requests to the host page, serves front-end build files from the static copy), `frame.js` (title and address sync)
- `scripts/build-site.mjs`: assembles the static site (`npm run build:site`); `scripts/serve-site.mjs` serves it like GitHub Pages (`npm run serve`)
- `.github/workflows/pages.yml`: publishes the demo to GitHub Pages from `main`
- `scripts/start.mjs`: `npm start`, builds the site if missing and serves it
- `scripts/build-hosted.mjs` + `vercel.json`: the same build in one step for hosts that build from the repository (`npm run build:hosted`)
- `test/`: parity scenario and Node runner (`parity.test.mjs`), the hosted demo end to end (`site.test.mjs`, including Publish through a stand-in broker and Surge), the packer (`publish.test.mjs`), the broker (`broker.test.mjs`) and at the root of a domain (`root.test.mjs`), and the storage layer against a stand-in folder (`storage.test.mjs`)

## Pull requests

- Title: `[haxcms-browser] <Descriptive title>`
- Run `npm run precheck`, `npm run lint:security` and `npm test` (against haxcms-nodejs main) before pushing.
- Reference the issue in haxtheweb/issues in the PR body.
