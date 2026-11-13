# haxcms-browser

HAXcms running in the browser. [haxcms-nodejs](https://github.com/haxtheweb/haxcms-nodejs) is bundled to run in a Worker, the same way [create](https://github.com/haxtheweb/create) builds on it for the HAX CLI. People can try HAX, and build real sites, with nothing installed and nothing saved on a server we run.

Scope and plan: [haxtheweb/issues#3331](https://github.com/haxtheweb/issues/issues/3331)

## Try it

**https://haxtheweb.github.io/haxcms-browser/** (published from `main`, and rebuilt nightly against haxcms-nodejs `main`)

You get the real HAX dashboard and editor. Make a site from a template, open it, edit pages, save. What to know while it is this early:

- **Sites live in the tab's memory.** Reloading or closing the tab you started in ends the session and its sites. Saving to a folder on your computer, and to browser storage, come next.
- **Keep the first tab open.** "Go to Site" opens a new tab; that page is still served by the tab where HAXcms started.
- **Details** in the top bar shows what is running, what is not available in the browser, and the build to quote in a bug report.
- Problems go to [haxtheweb/issues](https://github.com/haxtheweb/issues/issues).

> Status: early. The full haxcms-nodejs Express app runs in a Worker and the real HAX front end talks to it through a service worker, with the same results as Node (see [Parity](#parity)). Next: storage adapters (folder on your computer, browser storage, zip download) and the status element inside HAX's own top bar.

## How it works

```
host page (index.html)                     HAXcms pages (in a frame)
  ├─ Worker: haxcms-nodejs (unmodified)      dashboard, sites, editor
  │    + browser shims                         │ every request
  │    └─ fs → in-memory volume (memfs)        ▼
  └─ answers relayed requests  ◄────────  service worker (sw.js)
                                            ├─ front-end build files → static files
                                            └─ everything else → relayed to the host page
```

- **Nothing in haxcms-nodejs is copied or rewritten.** `scripts/build.mjs` bundles it with esbuild, swaps Node built-ins for browser versions, and replaces packages that need a server (git, sharp, puppeteer, ...) with stubs that throw when used.
- **The real Express app answers requests.** haxcms-nodejs is loaded with `HAXCMS_EMBEDDED=1` (it builds the app and every route but creates no server) in local mode, the same single-user mode as `hax serve`. The Worker's `http` replacement turns each request message into a request object Express can handle and collects the response.
- **A service worker connects the editor to the Worker.** HAXcms pages are mounted at `app/<session>/`. The service worker answers their requests: front-end build files come from a static copy of haxcms-nodejs's own `public/` folder, and everything else (pages, API calls, site files) is relayed to the host page, which passes it to its Worker. Nothing HAXcms asks for reaches a web server.
- **One local user, signed in for you.** The host page signs in through the real login route with the credentials haxcms-nodejs seeds on first start, and keeps the session cookie itself (a service worker cannot set cookies).
- **Files live in memory while you work.** haxcms-nodejs makes many synchronous file calls. Browsers have no synchronous file API, so the Worker keeps the site in an in-memory volume and storage adapters load it in and write it out.
- **Your site is a normal HAXsite folder.** What you make here opens with `hax serve` and deploys like any other HAX site.

## What is not available in the browser

The Worker reports these on boot (`unavailable`), so the editor and the status page can say so:

| Feature           | Why                      | Plan         |
| ----------------- | ------------------------ | ------------ |
| Revisions (git)   | needs the `git` program  | off at first |
| Image resizing    | sharp is a native binary | off at first |
| PDF / DOCX / EPUB | puppeteer, converters    | off          |

Content sanitizing is **not** on this list: jsdom and DOMPurify are bundled, so what you save is cleaned by the same code as on a server.

## Develop

```bash
npm ci
export HAXCMS_NODEJS_SRC=/path/to/haxcms-nodejs/src   # optional, see below
npm run build      # dist/haxcms-worker.js + dist/haxcms-snapshot.json
npm test           # parity + hosted-demo tests in headless Chrome
npm run precheck   # prettier + eslint on changed files

# run the demo locally, served like GitHub Pages
npm run build:site -- --link
npm run serve      # http://127.0.0.1:8080/haxcms-browser/
```

`HAXCMS_NODEJS_SRC` builds and tests against a haxcms-nodejs checkout. CI uses the latest `main`, because the runtime has to keep up with what is about to ship; for a pull request whose branch name also exists in haxcms-nodejs, CI uses that branch, so changes that need both repos can be tested before either lands. Without `HAXCMS_NODEJS_SRC`, the published `@haxtheweb/haxcms-nodejs` package is used (it does not support `HAXCMS_EMBEDDED` yet). Tests need Chrome or Chromium (`PUPPETEER_EXECUTABLE_PATH`, default `/usr/bin/google-chrome`).

## Parity

`test/parity.test.mjs` sends the same HTTP requests to haxcms-nodejs on Node (real disk) and in the browser Worker (in-memory volume) and requires identical results: the dashboard and editor handshakes, site creation, outline saves, and the failures (a parent cycle, a page that is its own parent, a missing site token) that must be refused without touching `site.json`. It also checks that a password hash made in the browser verifies on a Node server.

`test/site.test.mjs` runs the hosted demo itself, served under `/haxcms-browser/` like GitHub Pages: the dashboard opens signed in, a site is created, opened in its own tab and saved to (with a `<script>` in the content, which must come back stripped), writes from outside a session are refused, and no HAXcms request reaches the web server.

## Publishing the demo

`.github/workflows/pages.yml` builds the site on every push to `main` (and nightly) and publishes it to GitHub Pages. One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is about 260 MB, nearly all of it haxcms-nodejs's front-end build.

## Licenses

The Worker bundle ships its dependencies' code, so every package in it must have a license compatible with Apache-2.0. `license-check` enforces this on every dependency change. Runtime pieces: memfs (Apache-2.0), @jspm/core (Apache-2.0), scrypt-js (MIT), plus haxcms-nodejs and its dependencies.

## License

[Apache-2.0](LICENSE.md)
