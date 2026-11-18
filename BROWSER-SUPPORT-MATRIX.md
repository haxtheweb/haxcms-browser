# Browser support

| Browser                | Runs HAXcms | Saved in the browser | Save to a folder on your computer |
| ---------------------- | ----------- | -------------------- | --------------------------------- |
| Chrome, Edge, Chromium | yes         | yes                  | yes (File System Access API)      |
| Firefox                | yes         | yes                  | no (no folder picker)             |
| Safari, iOS browsers   | yes         | yes                  | no (no folder picker)             |

The demo needs service workers and web workers (some browsers turn service workers off in private windows). Saving in the browser uses the origin private file system, which the Worker opens itself: Safari and every iOS browser (WebKit) cannot send a directory handle to a Worker. Saving to a folder needs `showDirectoryPicker`, which only Chromium-based browsers ship; elsewhere the button is not shown.

The full test suite runs in headless Chrome. The Firefox and Safari rows come from `npm run test:engines`, which CI runs on every pull request, on `main` and nightly: it starts HAXcms, makes a site, saves it in the browser and reloads, in Playwright's builds of Firefox and WebKit (the engine of Safari and of every browser on iOS). Those are desktop Linux builds, so iOS itself, and anything outside that journey, is still checked by hand.

## Installing and working offline

| Browser                | Install as an app          | Works offline | Share target |
| ---------------------- | -------------------------- | ------------- | ------------ |
| Chrome, Edge, Chromium | yes                        | yes           | yes          |
| Firefox                | Android only, untested     | untested      | no           |
| Safari                 | Add to Home Screen or Dock | untested      | no           |

Working offline needs Cache Storage and a service worker. The share target and the install button are Chromium features; Safari installs from its Share menu. Only headless Chrome is tested so far.
