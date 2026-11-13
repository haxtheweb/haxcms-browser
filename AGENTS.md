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
- **Test against haxcms-nodejs main**, not only the published package (`HAXCMS_NODEJS_SRC`).
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
- `src/runtime/shims/`: Node built-ins the Worker provides itself (fs → memfs, process, os, crypto with scrypt, async_hooks)
- `test/`: parity scenario, Node runner, and the headless Chrome test

## Pull requests

- Title: `[haxcms-browser] <Descriptive title>`
- Run `npm run precheck`, `npm run lint:security` and `npm test` (against haxcms-nodejs main) before pushing.
- Reference the issue in haxtheweb/issues in the PR body.
