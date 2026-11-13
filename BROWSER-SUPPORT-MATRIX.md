# Browser support

| Browser                | Runs HAXcms | Saved in the browser | Save to a folder on your computer |
| ---------------------- | ----------- | -------------------- | --------------------------------- |
| Chrome, Edge, Chromium | yes         | yes                  | yes (File System Access API)      |
| Firefox                | untested    | untested             | no (no folder picker)             |
| Safari                 | untested    | untested             | no (no folder picker)             |

The demo needs service workers and web workers (some browsers turn service workers off in private windows). Saving in the browser uses the origin private file system. Saving to a folder needs `showDirectoryPicker`, which only Chromium-based browsers ship; elsewhere the button is not shown. The tests run in headless Chrome only so far.
