# haxcms-browser

HAXcms running in the browser. [haxcms-nodejs](https://github.com/haxtheweb/haxcms-nodejs) is bundled to run in a Worker, the same way [create](https://github.com/haxtheweb/create) builds on it for the HAX CLI. People can try HAX, and build real sites, with nothing installed and nothing saved on a server we run.

Scope and plan: [haxtheweb/issues#3331](https://github.com/haxtheweb/issues/issues/3331)

> Status: early. The full haxcms-nodejs Express app runs in a Worker and answers real HTTP API requests (create a site, save the outline, ...) with the same results as Node (see [Parity](#parity)). Next: the service worker that sends the editor's requests to it, storage adapters, and editor wiring.

## How it works

```
editor (HAX, haxcms-site-editor-ui)
   │ API calls
   ▼
service worker ──► Worker: haxcms-nodejs (unmodified) + browser shims
                     └─ fs → in-memory volume (memfs)
                          └─ saved to: a folder on your computer (Chrome, Edge)
                                       or browser storage (all browsers)
```

- **Nothing in haxcms-nodejs is copied or rewritten.** `scripts/build.mjs` bundles it with esbuild, swaps Node built-ins for browser versions, and replaces packages that need a server (git, sharp, puppeteer, ...) with stubs that throw when used.
- **The real Express app answers requests.** haxcms-nodejs is loaded with `HAXCMS_EMBEDDED=1` (it builds the app and every route but creates no server) in local mode, the same single-user mode as `hax serve`. The Worker's `http` replacement turns each request message into a request object Express can handle and collects the response.
- **Files live in memory while you work.** haxcms-nodejs makes many synchronous file calls. Browsers have no synchronous file API, so the Worker keeps the site in an in-memory volume and storage adapters load it in and write it out.
- **Your site is a normal HAXsite folder.** What you make here opens with `hax serve` and deploys like any other HAX site.

## What is not available in the browser

The Worker reports these on boot (`unavailable`), so the editor and the status page can say so:

| Feature           | Why                      | Plan                          |
| ----------------- | ------------------------ | ----------------------------- |
| Revisions (git)   | needs the `git` program  | off at first                  |
| Image resizing    | sharp is a native binary | off at first                  |
| PDF / DOCX / EPUB | puppeteer, converters    | off                           |
| Content sanitize  | jsdom (needs a DOM)      | must work before page editing |
| Login             | single local user        | not needed                    |

## Develop

```bash
npm ci
export HAXCMS_NODEJS_SRC=/path/to/haxcms-nodejs/src   # optional, see below
npm run build      # dist/haxcms-worker.js + dist/haxcms-snapshot.json
npm test           # parity tests in headless Chrome
npm run precheck   # prettier + eslint on changed files
```

`HAXCMS_NODEJS_SRC` builds and tests against a haxcms-nodejs checkout. CI uses the latest `main`, because the runtime has to keep up with what is about to ship; for a pull request whose branch name also exists in haxcms-nodejs, CI uses that branch, so changes that need both repos can be tested before either lands. Without `HAXCMS_NODEJS_SRC`, the published `@haxtheweb/haxcms-nodejs` package is used (it does not support `HAXCMS_EMBEDDED` yet). Tests need Chrome or Chromium (`PUPPETEER_EXECUTABLE_PATH`, default `/usr/bin/google-chrome`).

## Parity

`test/parity.test.mjs` sends the same HTTP requests to haxcms-nodejs on Node (real disk) and in the browser Worker (in-memory volume) and requires identical results: the dashboard and editor handshakes, site creation, outline saves, and the failures (a parent cycle, a page that is its own parent, a missing site token) that must be refused without touching `site.json`. It also checks that a password hash made in the browser verifies on a Node server.

## Licenses

The Worker bundle ships its dependencies' code, so every package in it must have a license compatible with Apache-2.0. `license-check` enforces this on every dependency change. Runtime pieces: memfs (Apache-2.0), @jspm/core (Apache-2.0), scrypt-js (MIT), plus haxcms-nodejs and its dependencies.

## License

[Apache-2.0](LICENSE.md)
