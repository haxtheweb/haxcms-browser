# Browser support

| Browser                | Runs HAXcms | Saved in the browser | Save to a folder on your computer |
| ---------------------- | ----------- | -------------------- | --------------------------------- |
| Chrome, Edge, Chromium | yes         | yes                  | yes (File System Access API)      |
| Firefox                | untested    | untested             | no (no folder picker)             |
| Safari                 | untested    | untested             | no (no folder picker)             |

The demo needs service workers and web workers (some browsers turn service workers off in private windows). Saving in the browser uses the origin private file system. Saving to a folder needs `showDirectoryPicker`, which only Chromium-based browsers ship; elsewhere the button is not shown. The tests run in headless Chrome only so far.

## Installing and working offline

| Browser                | Install as an app          | Works offline | Share target |
| ---------------------- | -------------------------- | ------------- | ------------ |
| Chrome, Edge, Chromium | yes                        | yes           | yes          |
| Firefox                | Android only, untested     | untested      | no           |
| Safari                 | Add to Home Screen or Dock | untested      | no           |

Working offline needs Cache Storage and a service worker. The share target and the install button are Chromium features; Safari installs from its Share menu. Only headless Chrome is tested so far.
