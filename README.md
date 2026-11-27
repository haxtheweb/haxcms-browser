# haxcms-browser

HAXcms running in the browser. [haxcms-nodejs](https://github.com/haxtheweb/haxcms-nodejs) is bundled to run in a Worker, the same way [create](https://github.com/haxtheweb/create) builds on it for the HAX CLI. People can try HAX, and build real sites, with nothing installed and nothing saved on a server we run.

Scope and plan: [haxtheweb/issues#3331](https://github.com/haxtheweb/issues/issues/3331)

## Try it

**https://haxtheweb.github.io/haxcms-browser/** (published from `main`, and rebuilt nightly against haxcms-nodejs `main`)

You get the real HAX dashboard and editor. Make a site from a template, open it, edit pages, save. What to know while it is this early:

- **Your sites are saved in this browser by default**, so a reload brings them back. The bar always says where they are being saved.
- **Save to a folder** (Chrome, Edge) writes them to a folder you pick on your computer instead. Pick an empty folder, or one that already holds HAX sites. Each site is its own folder there, a normal HAXsite you can open later with `hax serve` or deploy. The folder is remembered for next time.
- **A save only succeeds once it is written.** If the folder can't be written (moved, deleted, permission lost), the editor gets an error and the bar says "Not saved".
- **Keep the first tab open.** "Go to Site" opens a new tab; that page is still served by the tab where HAXcms started. A second HAXcms tab runs without saving, so two tabs can't overwrite each other.
- **Download site** in the dashboard gives you a zip of a site.
- **Publish** (on browser.hax.cloud) puts a site on the web for free: Surge, GitHub Pages, GitLab Pages, Codeberg Pages, Netlify or Vercel. See [Publishing a site](#publishing-a-site).
- **Sign in** with Google, Microsoft, GitHub, GitLab or Apple: new sites get you as their author, an About page with your name and picture, and on a blog a first post.
- **Save to the cloud** keeps your sites in Google Drive, OneDrive, Dropbox, Box or a WebDAV server such as Nextcloud, so they aren't tied to one browser.

Which services a deployment offers depends on the OAuth apps whoever runs it has registered: see [docs/providers.md](docs/providers.md).

- **Details** in the top bar shows what is running, what is not available in the browser, and the build to quote in a bug report.
- Problems go to [haxtheweb/issues](https://github.com/haxtheweb/issues/issues).

### Link straight to making a site

`https://browser.hax.cloud/?skeleton=<machine name>&name=<site name>` opens the dashboard's create step with that starter picked and the name filled in; nothing is made until the person confirms. It is the browser version of `hax site <name> --skeleton-machine-name <machine name>`, so an agent that would run that command for someone at a terminal can hand a person without one this link instead (`?skeleton=portfolio&name=My%20work`). `skeleton` must be the machine name of a starter HAXcms lists (online-course, portfolio, art-portfolio, club-website, docs, blog, resume-journey, ...); anything else opens the normal start screen. Both values are taken out of the address once read, so a reload does not start over.

### Link straight to remixing a site

`https://browser.hax.cloud/?remix=<address of a published HAX site>` opens the dashboard's From a URL import with that address and the HAXcms kind filled in; nothing is fetched or made until the person continues. Every published HAX site whose license allows derivatives links here from its `remix_site` WebMCP tool and form, so a visitor or their agent can make their own copy to change. Published HAX sites answer cross-origin requests (`Access-Control-Allow-Origin: *` on GitHub Pages and Vercel), which is what lets the browser read them. Only an `http(s)` address without a login is taken; its query and fragment are dropped.

### Open in HAX: hand a site over from another website

A website that builds a HAXcms site in the browser (a site generator, a converter, a wizard) can open what it made straight in HAX, with no download and no publishing step ([haxtheweb/issues#3405](https://github.com/haxtheweb/issues/issues/3405)). It opens `https://browser.hax.cloud/?handoff=1` and passes the site zip from its tab to the new one with `postMessage`. The zip never reaches a server. Before anything is accepted, HAX asks the person, naming the sending website. Then the site goes through HAXcms's own import and create routes, so it is checked and sanitized like any import, and it opens in the editor.

The easy way is the helper this site serves. It has no dependencies, and it opens whichever HAX it was loaded from, so a self-hosted copy works the same way:

```html
<script type="module" src="https://browser.hax.cloud/open-in-hax.js"></script>
<open-in-hax site-title="My homepage" generator="My generator"></open-in-hax>
<script>
  // resolve the site as a HAXcms site zip (a Blob or ArrayBuffer)
  document.querySelector("open-in-hax").getSite = async () => zipBlob;
  document.addEventListener("open-in-hax-result", (e) => console.log(e.detail));
</script>
```

Or call `openInHax({ getSite, title, generator })` from your own button's click handler (`import { openInHax } from "https://browser.hax.cloud/open-in-hax.js"`). Call it from a click, or the browser blocks the new tab. Don't set `Cross-Origin-Opener-Policy: same-origin` on the generator page: it cuts the link between the two tabs.

**The site zip** is what HAXcms's Download site gives: `site.json` with `pages/`, `files/` and optionally `custom/build/custom.es6.js` (a custom theme), at the top of the zip or one folder down. `site.json` must be a HAXcms site outline. That means 1 to 5000 items, each with a unique id (letters, digits, `_ . : -`), its page at `pages/…/….html`, any `metadata.files` under `files/`, and `title`, `slug` and `parent` as text if given. Anything else is refused whole. The theme named in `metadata.theme.element` is used when this HAX has it; otherwise the site gets the default theme. Up to 100 MB.

**The protocol** (`hax-handoff`, version 1), for anyone writing their own sender. Every message is `{ protocol: "hax-handoff", version: 1, type, ... }`:

| type      | from             | carries                                                                                                                  |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ready`   | HAX → the opener | `versions: [1]`                                                                                                          |
| `offer`   | generator        | `generator: { name, url }`, `title`, `format: "haxcms-zip"`, `size` (bytes). Shown in the prompt                         |
| `consent` | HAX              | `allowed: true` or `false`                                                                                               |
| `payload` | generator        | `data`: the zip as a `Blob` or `ArrayBuffer`                                                                             |
| `result`  | HAX              | `ok: true, name` or `ok: false, error`: `declined`, `too-large`, `not-a-zip`, `invalid-site`, `timeout`, `import-failed` |

Rules HAX keeps:

- It takes messages only from the window that opened it, and after the offer only from that offer's origin.
- It reads no payload before the person allows it, and refuses a payload bigger than its offer said.
- It ignores unknown versions and types.
- Each tab does one handoff, and `?handoff` is removed from the address once read.
- The prompt names the sending website by the origin the browser reports, not by what the sender claims.

Senders should post only to HAX's origin, never `"*"`.

**Why this is on here and off on servers.** A site zip can carry the site's own JavaScript (`custom.es6.js`). Here HAXcms runs in the person's own tab and serves only them, so this build turns site zip import on (`HAXCMS_SITE_ZIP_IMPORT=true` in the Worker). haxcms-nodejs and haxcms-php leave it off unless the operator turns it on (`security.siteZipImport`).

> Status: early. The full haxcms-nodejs Express app runs in a Worker and the real HAX front end talks to it through a service worker, with the same results as Node (see [Parity](#parity)). Sites are saved to browser storage or a folder on your computer. Next: the status element inside HAX's own top bar, opening a single site folder directly, and other browsers.

## How it works

```
host page (index.html)                     HAXcms pages (in a frame)
  ├─ Worker: haxcms-nodejs (unmodified)      dashboard, sites, editor
  │    + browser shims                         │ every request
  │    └─ fs → in-memory volume (memfs)        ▼
  │         ⇅ sites folder ⇄ your folder / browser storage
  └─ answers relayed requests  ◄────────  service worker (sw.js)
                                            ├─ front-end build files → static files
                                            └─ everything else → relayed to the host page
```

- **Nothing in haxcms-nodejs is copied or rewritten.** `scripts/build.mjs` bundles it with esbuild, swaps Node built-ins for browser versions, and replaces packages that need a server (git, puppeteer, ...) with stubs that throw when used. sharp (image handling, a native binary) is replaced by a small stand-in built on the browser's own image decoding (`src/runtime/shims/sharp.cjs`), so uploads are checked and resized the way the backend expects.
- **The real Express app answers requests.** haxcms-nodejs is loaded with `HAXCMS_EMBEDDED=1` (it builds the app and every route but creates no server) in local mode, the same single-user mode as `hax serve`. The Worker's `http` replacement turns each request message into a request object Express can handle and collects the response.
- **A service worker connects the editor to the Worker.** HAXcms pages are mounted at `app/<session>/`. The service worker answers their requests: front-end build files come from a static copy of haxcms-nodejs's own `public/` folder, and everything else (pages, API calls, site files) is relayed to the host page, which passes it to its Worker. Nothing HAXcms asks for reaches a web server. The backend is told the page's real address, so the links it builds (an uploaded file's address, for one) point back into the mount. One exception: the code editor runs in a blank frame, which Chrome does not route through a service worker, so its script is pointed at the static copy directly.
- **One local user, signed in for you.** The host page signs in through the real login route with the credentials haxcms-nodejs seeds on first start, and keeps the session cookie itself (a service worker cannot set cookies).
- **Files live in memory while you work, and are written out on every change.** haxcms-nodejs makes many synchronous file calls and browsers have no synchronous file API, so the Worker works on an in-memory volume. `src/runtime/storage.cjs` loads the sites folder from a directory handle on start (a folder you picked, or the browser's private file system: the same API) and writes what changed back after every request that can change something, before that request is answered. A failed write turns the response into an error. When you come back to the tab, files changed in the folder by other programs are picked up.
- **Your site is a normal HAXsite folder.** What you make here opens with `hax serve` and deploys like any other HAX site.

## Install it and work offline

The page is an installable web app (`src/site/manifest.webmanifest`). When the browser says the page can be installed (Chrome, Edge), a notice offers to install it; on iPhone and iPad the notice says how (Share, then Add to Home Screen). **Not now** keeps it quiet for two weeks, and **Install this app** under Details is always there. The manifest is requested with the page's cookies (`crossorigin="use-credentials"`), so a copy behind a sign-in, such as a Vercel preview with Deployment Protection, stays installable. The app icons are the Future Traveler logo (`hax:future-traveler`), copied unchanged from [haxtheweb/art `future-traveler-logo/png`](https://github.com/haxtheweb/art/tree/main/future-traveler-logo): `logo-192` and `logo-512` as `icon-192.png` and `icon-512.png`, and the on-white versions for the maskable and Apple icons, which the device crops. Installed, it opens in its own window, the browser keeps what it has saved (Safari clears a site it has not seen for a week unless it is on the home screen), and it shows up in the device's share sheet.

**Offline.** Installing, or **Make available offline** under Details, saves a copy of the whole site in the browser: the host page, the Worker, and the HAXcms front end with the translations for the languages your browser asks for (about 65 MB on disk, less to download). From then on HAX opens and works with no connection: making sites, editing, saving, managing. Publishing still needs a connection.

- **Nothing is cached until you ask.** In a browser that has not installed HAX or asked for offline use, every load comes from the web server, exactly as before. This is only ever part of the browser version: sites you make, publish or run with haxcms-nodejs or haxcms-php never get a service worker from it.
- **A copy is one build, whole.** `scripts/offline-manifest.mjs` lists every file with its size and gives the set a build id (`offline-manifest.json`). The copy is saved only by the host page (`src/site/offline.js`), counts once the last file is in, and is never added to as pages load, so the parts always match each other. With a copy, the browser uses it for the host page and the front end, with or without a connection.
- **Updates are offered, not taken.** When the web server has a newer build, a notice says so and **Update** saves it beside the old copy (only changed files are downloaded) and swaps them when it is complete. It is used from the next reload. Until then you keep working on the build you have.
- **Getting out is easy.** **Remove offline copy** under Details goes back to loading from the web. **Reset the app** (`reset.html`) also removes the service worker; it needs nothing else to work and the service worker never answers for it, so it works even when HAX will not start. Neither touches your sites. For a problem that reaches everyone, changing `OFFLINE_FORMAT` in `src/site/sw.js` makes every browser drop its copy the next time it checks in.

Not saved offline: fonts and anything else HAXcms loads from other websites (pages fall back to the device's fonts), and translations for languages the browser did not ask for when the copy was saved.

**Sharing to HAX.** Installed (Android, Chrome OS, desktop Chrome and Edge), HAX is a share target: share a photo, a file, a link or some text from another app, pick the site, and it becomes a new page. Files go to the site's `files/` folder and the page is created through HAXcms's own API, so it is sanitized and saved like anything made in the editor. Nothing is added until you confirm (`src/site/share.js`).

## What is not available in the browser

The Worker reports these on boot (`unavailable`), so the editor and the status page can say so:

| Feature                 | Why                     | Instead                                                                                  |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| Revisions (git)         | needs the `git` program | not yet ([haxtheweb/issues#3389](https://github.com/haxtheweb/issues/issues/3389))       |
| PDFs made by the server | puppeteer drives Chrome | PDF export opens the browser's print dialog (Save as PDF), as on a server without Chrome |

Content sanitizing is **not** on this list: jsdom and DOMPurify are bundled, so what you save is cleaned by the same code as on a server. Word import and export, PDF import, EPUB export and readability scores are not on it either: their packages are bundled and give the same results as on Node (`test/parity.test.mjs`).

**Limited here: anything fetched from a web address.** Importing a site from its address, adding a file from a link, video details and link checks are made by the browser (`src/runtime/shims/outbound.cjs`), so they only work for sites that allow requests from other websites (CORS). For the rest, download the file and upload it. haxcms-nodejs's own checks run first (scheme, size, timeout, private addresses); names that only mean something on this device or a local network (`localhost`, `*.local`, a single label like `router`) and private addresses are refused before any request, the browser never sends this page's cookies, and an address a redirect lands on is checked the same way before its body is read. Details lists this under "Limited here".

## Run it locally

```bash
npm install
npm start          # first run builds the site (several minutes), then serves it
```

Open http://127.0.0.1:8080/haxcms-browser/ in Chrome or Edge. `npm start -- --rebuild` builds again after pulling changes.

## Develop

```bash
npm ci
export HAXCMS_NODEJS_SRC=/path/to/haxcms-nodejs/src   # optional, see below
npm run build      # dist/haxcms-worker.js + dist/haxcms-snapshot.json
npm test           # parity + hosted-demo tests in headless Chrome
npm run test:engines   # the demo in WebKit and Firefox (once: npx playwright-core install webkit firefox)
npm run precheck   # prettier + eslint on changed files

# run the demo locally, served like GitHub Pages
npm run build:site -- --link
npm run serve      # http://127.0.0.1:8080/haxcms-browser/
```

`HAXCMS_NODEJS_SRC` builds and tests against a haxcms-nodejs checkout. CI uses the latest `main`, because the runtime has to keep up with what is about to ship; for a pull request whose branch name also exists in haxcms-nodejs, CI uses that branch, so changes that need both repos can be tested before either lands. Without `HAXCMS_NODEJS_SRC`, the published `@haxtheweb/haxcms-nodejs` package is used (it does not support `HAXCMS_EMBEDDED` yet). Tests need Chrome or Chromium (`PUPPETEER_EXECUTABLE_PATH`, default `/usr/bin/google-chrome`).

## Parity

`test/parity.test.mjs` sends the same HTTP requests to haxcms-nodejs on Node (real disk) and in the browser Worker (in-memory volume) and requires identical results: the dashboard and editor handshakes, site creation, outline saves, and the failures (a parent cycle, a page that is its own parent, a missing site token) that must be refused without touching `site.json`. It also checks that a password hash made in the browser verifies on a Node server.

`test/site.test.mjs` runs the hosted demo itself, served under `/haxcms-browser/` like GitHub Pages: the dashboard opens signed in, a site is created, opened in its own tab and saved to (with a `<script>` in the content, which must come back stripped), sites survive a reload, a second tab does not save, Save to a folder writes the sites there and later saves follow, a folder that is not for HAX sites is refused, a save that cannot reach the folder is reported as failed, Download site returns a zip, a file uploaded in the editor is stored and served back from the page's own address, a site is saved as a template, clicking a site on the dashboard opens it, the code editor loads, writes from outside a session are refused, and no HAXcms request reaches the web server.

`test/root.test.mjs` serves the same site at the root of a domain (Vercel, a custom domain) and checks it starts, makes a site and opens it.

`test/storage.test.mjs` checks the storage layer on its own against a stand-in folder, including writes that fail part-way: the old file is kept and the change is retried.

## Publishing a site

Scope and plan: [haxtheweb/issues#3341](https://github.com/haxtheweb/issues/issues/3341). Setting up each service: [docs/providers.md](docs/providers.md).

**Publish** in the top bar picks a site and a host:

- **Surge** (no setup): an address (`something.surge.sh`, or a domain you pointed at Surge) and a Surge account. The Worker packs the site into a gzipped tarball and the page sends it through the **publish broker** (`api/surge/deploy`) to the [Surge deploy API](https://surge.sh/docs/api/deploys). Surge accounts: a pasted token (`surge tokens add --domain <address>` makes one that only works for that address), or an email and password, which the broker sends to Surge once to get a token (`api/surge/token`; Surge creates the account if there is none).
- **GitHub Pages, GitLab Pages, Codeberg Pages, Netlify, Vercel** (when the deployment has set them up): a name, and the person's account on that host, signed in with a popup. The page then publishes straight to the host's API from the browser (`src/site/publish-hosts.js`), so there is no size limit of ours. Each host's dialog note says what it makes (a public repository, a project, a site) and the host's own limits.
- **A Waypoint** (on every copy, with or without the publish service): a server that builds a static copy of the site and serves it at a web address, where the person can also add their own domain. See [Publishing to a Waypoint](#publishing-to-a-waypoint).

Every host gets the same files (`src/runtime/publish.cjs`): what `hax site site:surge` publishes, with `ghpages.html` served as `index.html`, `llms-full.txt` added as the in-browser HAXcms serves it (none for private sites; a site's own file is kept), and without what only a local HAXcms needs (`build/`, `wc-registry.json`, `assets/babel*`, `node_modules`, `dist`, logs, dotfiles, symbolic links). The site itself is not changed. GitHub Pages also gets `.nojekyll`; GitLab Pages gets the site in `public/` plus a `.gitlab-ci.yml`.

The host and name (or Surge address) last used are remembered for each site in this browser; a site's `CNAME` (where the CLI published it) is used first for Surge.

### Publishing to a Waypoint

A [Waypoint](https://github.com/haxtheweb/issues/issues/3422) is a server that builds a static copy of a site and serves it at a web address. You keep editing here; publishing again to the same name replaces what is there, and the Waypoint keeps earlier versions to go back to. It answers this page directly, so it needs no publish broker and is offered on every copy of the page (`src/site/publish-waypoint.js`).

1. The person gives the address of the Waypoint and a name for the site. The page asks that address what it is (`/.well-known/waypoint`) and stops if it does not let people publish from other websites, or if the packed site is over its limit.
2. A window opens on `waypoint-callback.html`, a small page of this site, and goes on to the Waypoint's own approval page. The person signs in there if needed and presses Allow. Nobody types a password or a token into this page.
3. The Waypoint sends the window back to `waypoint-callback.html` with a one-time code (authorization code with PKCE, no client secret), which the page exchanges for a pass that lasts fifteen minutes and only works from this page's origin.
4. With the pass the page makes the site on the Waypoint if the person has none of that name, sends the same tarball every other host gets, and waits while the Waypoint checks the site, cleans its pages and builds it.
5. The bar shows the site's address. With "private preview address first" ticked, the site is not made live; the bar shows a preview link instead.

What is kept: the Waypoint's address and the name last used, in this browser. The code and the pass are never stored. The two pages talk over a `BroadcastChannel`, which only reaches pages of this origin, and the window drops its link to the page that opened it before it goes to the Waypoint. Plain http is accepted only for a Waypoint on this computer (`localhost`, `127.0.0.1`, `*.localhost`).

The operator of each Waypoint decides which websites may do this: this page's origin (for example `https://browser.hax.cloud`) has to be on that Waypoint's list, or its approval page says so. A Waypoint also sets how many sites a person may have; the bar says so when an account is full.

To try it against a Waypoint running on your own computer, set `WAYPOINT_URL` and run `test/site.test.mjs` (see the Waypoint tests there).

## Sign-in and cloud storage

**Sign in** (`src/site/accounts.js`, `src/site/auth.js`) opens the service in a popup. The broker runs the sign-in (`api/oauth/start`, `api/oauth/callback`) and finishes it with the app's client secret, and the page fetches the person's profile from the service. When someone has signed in, every site they make next gets their name, email and picture as its author, saved through HAXcms's own SEO settings route right after the site is created. It then gets an About page with their name and picture, unless the site already has a page called About (or About me, About us), and, when the site is a blog (the blog skeleton or the Simple Blog, Haxor Slevin or VHS Blog theme), a short first post titled "Hello from" their name. Both are added through HAXcms's items API, the request the editor's Add page makes; a skeleton's own pages are never changed. The email is not put on the About page.

**Save to the cloud** moves HAXcms onto cloud storage (`src/runtime/remote.cjs`): Google Drive (a `HAXcms sites` folder, `drive.file` scope), OneDrive (the app's own folder), Dropbox (the app folder), Box (a `HAXcms sites` folder) or a WebDAV server. It plugs into the same `storage.cjs` a folder on the computer uses, so the same saving rules hold: a change is answered only after it is written, and a failed upload leaves the cloud copy as it was. The Worker asks the page for current tokens and renews an expired one once.

Tokens stay in the tab: memory, and `sessionStorage` so a reload doesn't sign people out. A WebDAV app password is only kept in memory, so after a reload Reconnect asks for it again. The cloud choice (not its sign-in) is remembered, so the next visit offers **Reconnect**.

### The publish broker (`api/`)

Small [Vercel functions](https://vercel.com/docs/functions) deployed with the site. They keep nothing (no database, no files, no logs of what passed through) and only answer the page they are deployed with.

| Route                           | Does                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `GET /api/status`               | what this broker can publish to; the page asks before showing Publish |
| `POST /api/surge/token`         | Surge email and password → token                                      |
| `PUT /api/surge/deploy?domain=` | gzipped site tarball + `Authorization: Bearer <token>` → Surge        |
| `GET /api/oauth/providers`      | the sign-in services set up here, public parts only                   |
| `GET /api/oauth/start`          | the sign-in popup opens here; sends the person to the service         |
| `GET/POST /api/oauth/callback`  | every service sends people back here; code → tokens, client secret    |
| `GET /api/oauth/done`           | hands the sealed result to the page that started the sign-in          |
| `POST /api/oauth/refresh`       | a refresh token → a new access token                                  |

Rules it keeps (`api/_lib/broker.js`):

- Only the deployment's own origin, or origins listed in `HAX_BROKER_ALLOWED_ORIGINS` (comma-separated), may call it. It is not a public proxy.
- Requests only go to fixed addresses written in the code (Surge, each sign-in service's token endpoint); the domain a caller sends is validated as a hostname and used as one path segment, and a provider name only picks from the list.
- A sign-in is finished only when its state matches the signed cookie `api/oauth/start` set in the same browser (`HAX_OAUTH_STATE_SECRET`), and the tokens go back sealed with a key only the page that started it has.
- Passwords, tokens and client secrets never go into a log, a response header or an error message; `GET /api/oauth/providers` never returns secrets.
- Sites over 4 MB packed are refused (Vercel functions take at most 4.5 MB). Surge's API sends no CORS headers, so a browser can't reach it without the broker: the dialog states the limit up front and, for bigger sites, stops before uploading and points to Download site and the HAX CLI, which has no size limit.

### Forks and other copies

The page looks for the broker at `/api/` on its own origin. A fork deployed to Vercel from its own repository gets a working broker with no setup for Surge; for the other services it registers its own OAuth apps and sets the variables in [docs/providers.md](docs/providers.md). Copies on hosts without functions (the GitHub Pages copy, a fork on GitHub Pages) have no broker: Publish there says to use Download site and the HAX CLI.

## Publishing the demo

`.github/workflows/pages.yml` builds the site on every push to `main` (and nightly) and publishes it to GitHub Pages. One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is about 260 MB, nearly all of it haxcms-nodejs's front-end build.

### Vercel (or any host that builds from the repository)

`vercel.json` is in the repository: import the project in Vercel and deploy, no settings to change. It runs `npm run build:hosted` (`scripts/build-hosted.mjs`), which fetches haxcms-nodejs `main` (or the branch in `HAXCMS_NODEJS_REF`), builds the Worker and puts the site in `site/`. The site works at the root of a domain or under any path. For another host, use the same build command and publish `site/`.

Vercel only builds when this repository changes, so `.github/workflows/vercel-nightly.yml` asks for a production build of `main` every night (and on demand from the Actions tab), to follow haxcms-nodejs `main`. It calls a [Deploy Hook](https://vercel.com/docs/deploy-hooks): create one in the Vercel project (Settings → Git → Deploy Hooks, branch `main`) and store its URL as the repository secret `VERCEL_DEPLOY_HOOK`. Without the secret the job does nothing and says so.

The site's address goes into a canonical link, social cards, `sitemap.xml` and the `Sitemap:` line of `robots.txt`, for search engines and AI agents. On Vercel it is the project's production domain (`VERCEL_PROJECT_PRODUCTION_URL`); elsewhere set `HAX_SITE_URL` (for example `https://hax.example.edu/`). Without either, those are left out rather than guessed. `llms.txt` and `robots.txt` are always there. Publish also packs each published page as its own HTML file with its title, description and text, rendered by haxcms-nodejs as the HAX CLI does ([haxtheweb/issues#3352](https://github.com/haxtheweb/issues/issues/3352)).

## Licenses

The Worker bundle ships its dependencies' code, so every package in it must have a license compatible with Apache-2.0. `license-check` enforces this on every dependency change. Runtime pieces: memfs (Apache-2.0), @jspm/core (Apache-2.0), scrypt-js (MIT), plus haxcms-nodejs and its dependencies.

## License

[Apache-2.0](LICENSE.md)
