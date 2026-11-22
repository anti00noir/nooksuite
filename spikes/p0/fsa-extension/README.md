# FSA spike extension

Throwaway MV3 extension for Phase 0. It measures how the File System Access API
behaves in the three contexts NookBin might use:

- the toolbar **popup** (`popup.html`),
- a **top-level extension page** (`page.html`),
- an **extension iframe embedded in a web page** (`iframe.html`), which is how
  the NookBin floating panel is rendered.

All three share the same `chrome-extension://` origin, so a directory handle
saved in one context can be loaded in another. The iframe test is the important
one: Chromium rejects `showDirectoryPicker()` in cross-origin subframes with
`SecurityError`, so the panel may need to reuse a handle granted elsewhere.

## Load it

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the extension's toolbar icon.

## Tests

### Popup

- **Pick folder** — record whether the popup stays open when the native picker
  appears.
- **Open full-page test** — opens `page.html` in a tab.
- **Inject iframe test** — injects `iframe.html` into the active tab at a fixed
  position. Use a permissive page such as `https://example.com`; a strict site
  CSP can block `chrome-extension:` frames.

### Top-level page (`page.html`)

1. **Pick folder** → choose an empty folder.
2. **Run write test** → creates `.nooksuite/library.json` and
   `documents/<id>/hello.txt`, then reads them back.
3. Reload the page and click **Load saved handle** to confirm persistence.
4. **Request permission** to see the current permission state.

### Injected iframe (`iframe.html`)

1. **Pick folder** → expect `SecurityError: Cross origin sub frames aren't
   allowed to show a file picker.`
2. **Load saved handle** → should load the handle saved by the top-level page.
3. **Request permission** → record whether it is blocked.
4. **Run write test** → should pass if permission is already `granted`.
5. Restart the browser and repeat steps 2–4 to see whether permission survives
   a restart.

## Recording results

Fill in the tables in [`docs/spikes/p0/README.md`](../../../docs/spikes/p0/README.md).
