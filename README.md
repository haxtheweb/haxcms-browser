# haxcms-browser

HAXcms running in the browser. [haxcms-nodejs](https://github.com/haxtheweb/haxcms-nodejs) is bundled to run in a Worker, the same way [create](https://github.com/haxtheweb/create) builds on it for the HAX CLI. People can try HAX, and build real sites, with nothing installed and nothing saved on a server we run.

Scope and plan: [haxtheweb/issues#3331](https://github.com/haxtheweb/issues/issues/3331)

> Status: early. The runtime boots haxcms-nodejs in a Worker and runs its real site creation and `saveOutline` with the same results as Node (see [Parity](#parity)). The request bridge, storage adapters and editor wiring are next.

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

`HAXCMS_NODEJS_SRC` builds and tests against a haxcms-nodejs checkout. CI uses the latest `main`, because the runtime has to keep up with what is about to ship. Without it, the published `@haxtheweb/haxcms-nodejs` package is used. Tests need Chrome or Chromium (`PUPPETEER_EXECUTABLE_PATH`, default `/usr/bin/google-chrome`).

## Parity

`test/parity.test.mjs` runs the same scenario on Node (real disk) and in the browser Worker (in-memory volume) and requires identical results: site creation, outline saves, and the failure cases (a parent cycle, a page that is its own parent) that must return an error without touching `site.json`. It also checks that a password hash made in the browser verifies on a Node server.

## Licenses

The Worker bundle ships its dependencies' code, so every package in it must have a license compatible with Apache-2.0. `license-check` enforces this on every dependency change. Runtime pieces: memfs (Apache-2.0), @jspm/core (Apache-2.0), scrypt-js (MIT), plus haxcms-nodejs and its dependencies.

## License

[Apache-2.0](LICENSE.md)
