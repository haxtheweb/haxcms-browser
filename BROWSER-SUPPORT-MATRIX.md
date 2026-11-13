# Browser support

| Browser                | Runs HAXcms | Save to a folder (planned)   | Browser storage + zip (planned) |
| ---------------------- | ----------- | ---------------------------- | ------------------------------- |
| Chrome, Edge, Chromium | yes         | yes (File System Access API) | yes                             |
| Firefox                | yes         | no                           | yes                             |
| Safari                 | yes         | no                           | yes                             |

The demo needs service workers and web workers (some browsers turn service workers off in private windows). Saving to a folder is planned and needs `showDirectoryPicker`, which only Chromium-based browsers ship. The tests currently run in headless Chrome only; Firefox and WebKit runs are planned with the storage adapters.
