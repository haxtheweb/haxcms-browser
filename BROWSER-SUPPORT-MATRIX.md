# Browser support

| Browser                | Runs HAXcms | Save to a folder on your computer | Browser storage + zip download |
| ---------------------- | ----------- | --------------------------------- | ------------------------------ |
| Chrome, Edge, Chromium | yes         | yes (File System Access API)      | yes                            |
| Firefox                | yes         | no                                | yes                            |
| Safari                 | yes         | no                                | yes                            |

Saving to a folder needs `showDirectoryPicker`, which only Chromium-based browsers ship. The tests currently run in headless Chrome only; Firefox and WebKit runs are planned with the storage adapters.
