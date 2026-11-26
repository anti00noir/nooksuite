## Architecture

NookBin lives in `tools/nookbin/extension`; shared, target-agnostic logic it
imports lives in `packages/core` (`@nooksuite/core`). Paths below are relative
to those roots.

### Components

| File | Responsibility |
| --- | --- |
| `tools/nookbin/extension/src/manifest.json` | Declares the service worker, content scripts, permissions, keyboard shortcut, web-accessible panel files, and host access. |
| `background.js` | Handles toolbar clicks and the **Alt+Shift+N** shortcut, toggles the in-page panel, injects the content script into older tabs, opens a standalone fallback window on restricted pages, and owns the single native messaging connection. |
| `content.js` | Owns the floating panel host, handles dragging/docking/closing, keeps the panel above fullscreen content, and delivers files to the page. |
| `popup/popup.html` | Panel UI: header, library heading, search and filters, stored-file list, empty state, drop guide, and storage footer. |
| `popup/popup.css` | Responsive panel layout and charcoal theme styles. |
| `popup.js` | Handles drag/drop and file selection, filters and sorts the file list, sends the selected file to the active tab, and talks to the panel host. |
| `native-host.js` | Panel-side client for the background's native messaging bridge, including failure classification. |
| `packages/core/src/panel-position.js` | Pure geometry helpers for sizing the panel, docking it to the right, and keeping it inside the viewport. |
| `packages/core/src/record-storage.js` | Record storage interface with shared input validation. |
| `packages/core/src/backends/idb-record-storage.js` | IndexedDB implementation, used when the native host is unavailable. |
| `packages/core/src/native/native-client.js` | Correlates requests and responses over one native messaging port. |
| `packages/core/src/native/native-library.js` | Record-store adapter for the native host, with chunked reads and base64 transfer. |
| `crates/nooksuite-library/` | Shared Rust implementation of format v1, used by NookEdit and the native host. |
| `tools/nookedit/host/` | Native messaging host: stdio framing, request dispatch, and the browser installer. |
| `fonts/` | Bundled IBM Plex Mono Web Fonts (SIL Open Font License). |

### Bundling

`build.mjs` runs esbuild with three entry points (`background.js`,
`content.js`, `popup.js`) and copies static assets (manifest, popup pages,
fonts) into `dist/` with sourcemaps. The bundled scripts are self-contained
IIFEs targeting Chrome 114, so the manifest references flat files and the
content script can `import` from `@nooksuite/core` even though manifest content
scripts cannot be ES modules. Chrome must load the extension from `dist/`.

### Floating panel

NookBin no longer uses Chrome's native action popup. Clicking the toolbar icon (or pressing the shortcut) sends a `togglePanel` message to the content script in the active tab. The content script creates a `<nookbin-panel>` element, attaches a shadow root, and loads `popup/popup.html` in an iframe.

The host is a manual HTML popover, so it is rendered in the browser's top layer. This keeps it above ordinary page content and lets it be re-shown above fullscreen content. When the page enters fullscreen, the Fullscreen API hides popovers that are not part of the fullscreen element; `content.js` listens for `fullscreenchange`, hides and re-shows the popover, and the panel stays visible on top.

The panel defaults to the right side of the viewport and is clamped so it cannot be dragged completely off-screen. Its last position is stored in `chrome.storage.local` under `nookbinPanelPosition`. The panel header has:

- A drag strip that moves the panel freely.
- A dock button that snaps it back to the right side.
- A close button that removes it from the page.

The panel's iframe is web-accessible so it can be loaded from a content script. It remains an extension page, so it has full access to `chrome.tabs`, `chrome.scripting`, and the extension's IndexedDB.

### Storage model

Documents are **records**, not names. A record carries a stable id, a
normalized display name, a media type, a size, timestamps, and the path of its
bytes. The format is shared by NookEdit and NookBin and is specified in
[`docs/library-format.md`](library-format.md).

Storage is split into an interface and a backend in `@nooksuite/core` so the
native library and the extension can share callers:

- `record-storage.js` exposes `createRecordStorage(backend)`, which owns the
  rules every target shares: name normalization, unique names, id creation,
  timestamps, and validation.
- `backends/idb-record-storage.js` implements the backend with IndexedDB.
  Records and bytes live in separate object stores, so listing a library never
  reads file contents.
- `native/native-library.js` implements the same surface over the native
  messaging protocol. The Rust host applies the shared rules, so the adapter
  only moves bytes.

The panel asks for the native library first. When the host is installed it
reads and writes the on-disk library; otherwise it falls back to the
extension's own IndexedDB. The footer names the active source ("NookSuite
library" or "Local only").

Fallback documents live in the extension's own IndexedDB:

- Database: `my-files`
- Database version: `2`
- `records` — keyPath `id`
- `blobs` — keyed by id
- `meta` — migration bookkeeping

Version 1 of the database keyed files by name in a single `files` store.
Version 2 migrates those entries into records on first open; the migration is
described in [`docs/library-format.md`](library-format.md#migrating-from-version-1).

This is extension-origin storage. Content scripts run in the page's origin and therefore cannot read it directly; the panel is responsible for reading files and passing them to the page. Because it is a fallback, switching to the native library does not migrate these records automatically.

### Shared library with NookEdit

NookBin and NookEdit read and write one on-disk library
(`Documents\NookSuite` by default, user-configurable). Phase 0 tested whether
the extension could own that folder directly with the File System Access API.
It cannot, so the library is owned by native code instead: the desktop app
writes it, and the native messaging host gives NookBin the same access.

Evidence is in [`docs/spikes/p0/README.md`](spikes/p0/README.md) and the
harness in `spikes/p0/fsa-extension`:

- Picking a directory works in a top-level extension page and in the toolbar
  popup, and the handle persists in IndexedDB.
- Permission is scoped to the **document**, not the origin: a reload drops it
  from `granted` back to `prompt`, and a browser restart does not restore it.
- In the panel's iframe the picker throws (`NotAllowedError`), and
  `requestPermission()` throws `SecurityError: Not allowed to request
  permissions in a third-party context`. The panel therefore cannot read file
  contents or write, even with a handle that was granted elsewhere.

Consequences:

- The floating panel never performs file I/O. It asks the background service
  worker, which talks to a **native messaging host** shipped with NookEdit.
- The host process owns the library: it creates `.nooksuite/`, allocates
  document IDs, performs atomic temp-then-rename writes, and streams bytes.
- No permission prompts, no extra tab, and no dependency on the page context.
- A File System Access "folder mode" is out of scope. Where the host is not
  installed, the panel falls back to IndexedDB.

The on-disk layout the host is responsible for:

```text
<library>/
├── .nooksuite/
│   └── library.json        # schemaVersion, records
└── documents/
    └── <id>/
        └── <original file>
```

#### Native implementation (Phase 2)

NookEdit implements that layout in `crates/nooksuite-library/src/library.rs`:

- `Library::open_or_create` creates `.nooksuite/` and `documents/` and loads or
  writes `library.json`.
- `import_path` copies a file into `documents/<id>/`, normalizes its name, and
  saves the index; `import_bytes` does the same for bytes that arrive over the
  wire.
- `rename` moves the file and updates the record; `remove` deletes the folder
  and the record.
- `read_text` / `read_bytes` read a record; `read_range` streams a slice for the
  host; `save_text` and `save_bytes` replace a file atomically and update its
  size and `updatedAt`; `export` writes a copy to a chosen destination.
- `atomic_write` writes through `library.json.tmp` and renames over the index.
- Ids, name normalization, media-type inference, and timestamp validation
  mirror `packages/core/src/library/`.

The crate is shared by the desktop app and the native host, so there is one
implementation of the format. Tauri commands (`open_library`, `import_documents`,
`rename_document`, `remove_document`, `read_document_text`,
`read_document_bytes`, `save_document`, `save_document_bytes`, `export_document`,
`export_bytes`) wrap those operations. The remembered library path lives in
`settings.json` in the app config directory, so the app reopens the last library
on launch.

`read_document_bytes` returns `tauri::ipc::Response`, so large files reach the
webview as an `ArrayBuffer` instead of a JSON array of numbers.
`save_document_bytes` and `export_bytes` take the opposite route: the request
body is the raw file and the library root, document id, or destination travels
in percent-encoded headers. This keeps PDF saves out of JSON.

#### Opening, editing, and page operations (Phases 3 and 5)

The renderer picks a mode from the record's media type and extension:

- Text-like files open in CodeMirror 6. Markdown also has a rendered preview
  (`react-markdown` with GFM). Saving sends the buffer to `save_document`; the
  Rust side writes the file atomically and updates the index. `Ctrl+S` and the
  Save button share that path.
- PDFs are read as bytes and rendered by pdf.js to a canvas, with page
  navigation, zoom, fit-width, and fit-page. The Pages view shows a lazy
  thumbnail grid where pages can be rotated, reordered, duplicated, deleted,
  and undone. Saving rewrites the PDF with pdf-lib (`copyPages` plus baked-in
  rotations) and sends the bytes to `save_document_bytes`; exporting writes the
  same bytes to the chosen destination without changing the library. pdf-lib is
  loaded on demand, so it is not part of the viewer's initial chunk.
- Images render from an object URL.
- Everything else shows metadata and can still be exported.

Export writes the current editor contents for text and Markdown (so unsaved
edits are included), the edited PDF when page changes are pending, and copies
bytes for images and unknown formats. Leaving the editor with unsaved changes
asks first. Closing the window is not guarded yet.

Page rewriting uses pdf-lib's `copyPages`, which does not carry over acroforms
or document outlines; the common metadata fields are copied explicitly. Page
operations on a PDF with form fields can therefore drop those fields; forms and
annotations are the next Phase 5 slice.

The editor, PDF viewer, and Markdown renderer are lazy-loaded; the library
screen boots without them.

#### Native messaging (Phase 4)

The host in `tools/nookedit/host` is a thin stdio layer over the shared crate:

- Chrome starts it when the extension calls
  `chrome.runtime.connectNative('dev.nooksuite.host')`. The registration is
  written by `scripts/install.mjs`.
- Requests and responses are a 4-byte little-endian length followed by one
  UTF-8 JSON object. The ops are `ping`, `list`, `import`, `read`, `rename`, and
  `remove`.
- Reads are chunked: the host returns at most 512 KB of raw bytes per message,
  because Chrome caps host-to-browser messages at 1 MB. Imports are one message
  and the extension caps them at 32 MB.
- The background service worker owns the single port, so every panel shares one
  host process and one writer. The panel sends request payloads over
  `chrome.runtime.sendMessage`.
- The host resolves the library root from `NOOKSUITE_LIBRARY_ROOT`, then the
  `libraryPath` in `settings.json`, then `Documents\NookSuite`. It never writes
  settings; NookEdit owns the picker.
- Diagnostics go to stderr; stdout carries only protocol frames.

The host is registered for Chrome and Edge under the current user. Because an
unpacked extension's id is derived from its folder path, the installer reads
the id from the browser's `Preferences` files and lists it in
`allowed_origins`. Re-run the installer if the extension moves.

A shared fixture, `packages/core/tests/fixtures/library-v1.json`, is parsed by
both the JavaScript and Rust test suites. A field-name or validation change
that breaks compatibility fails one of them.

### File transfer

Chrome extension messages do not carry a `File` or `Blob` directly, so the panel converts the selected file to a base64 string:

```js
{
  action: 'dropFile',
  fileName: string,
  fileType: string,
  data: string // base64-encoded file bytes
}
```

The panel sends this to frame `0` of the active tab:

```js
chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
```

The content script responds with:

```js
{ ok: true, target: 'file input' | 'upload area' | 'document body' }
```

or:

```js
{ ok: false, error: string }
```

If no content script is listening, the panel injects the bundled `content.js`
with `chrome.scripting.executeScript()` and retries once. This covers tabs that
were already open when the extension was installed or reloaded.

The transfer is currently capped at **32 MB** because the base64 payload is sent through extension messaging.

When the panel is running in the standalone fallback window, the active tab is the extension page itself. In that case, the panel targets the active tab of the last focused normal browser window instead.

### Page-side injection

`content.js` follows two paths:

1. **File input found**
   - Rebuilds the `File`.
   - Assigns it through a `DataTransfer` to `input.files`.
   - Dispatches `input` and `change` events.

2. **No file input found**
   - Looks for an element whose class or ID contains `upload`.
   - Falls back to `document.body`.
   - Dispatches `dragenter`, `dragover`, and `drop` events with the file in the `DataTransfer`.

The content script includes a load guard so injecting it again does not register duplicate message listeners.

### Restricted pages

Chrome does not allow content scripts on pages such as `chrome://` URLs, the Chrome Web Store, and the PDF viewer. When injection fails, the background service worker opens `popup/popup.html?standalone=1` in a small `popup` window. That window is movable by the operating system and can be focused again from the toolbar icon. It uses the same stored files and UI, but hides the in-page drag/dock/close controls.

### Permissions

| Permission | Why it is needed |
| --- | --- |
| `nativeMessaging` | Talk to the NookSuite host that owns the on-disk library. |
| `scripting` | Re-inject the content script into tabs that do not have it and detect restricted pages. |
| `storage` | Remember the floating panel position and the fallback window ID. |
| `unlimitedStorage` | Allow the IndexedDB fallback to hold document-sized files. |
| `<all_urls>` | Run the content script and inject into the active page. |

The extension requires Chrome 114 or newer because the floating panel relies on the HTML popover API.

### Loading the extension

1. Run `npm run build` from the repo root (or `npm run dev` for watch mode).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `tools/nookbin/extension/dist/` folder.
5. Optionally install the native host:
   `npm run host:install --workspace @nooksuite/host`. The installer finds the
   loaded extension id, copies the host into `%LOCALAPPDATA%\NookSuite\host`,
   and registers it with Chrome and Edge. Pass `-- --id=<id>` if detection
   fails.
6. After changing the code, reload the extension from the extensions page.
7. Already-open tabs can usually recover automatically through the injection fallback, but refreshing the page is the cleanest option.

### Current limitations

This is a proof of concept, so the following are intentionally simple:

- Only the **first file input in the top frame** is targeted.
- Iframes, shadow DOM, and custom canvas-based upload widgets are not specifically handled.
- The upload-area fallback is a heuristic and may not work on every site.
- Synthetic events may be ignored by pages that require trusted user input.
- Files over 32 MB cannot currently be injected, and the disk library refuses
  imports over 32 MB.
- Chrome blocks extensions on pages such as `chrome://`, the Chrome Web Store, and the PDF viewer. Those pages use the standalone fallback window instead.
- The in-page panel closes when the page navigates; reopen it from the toolbar or shortcut.
- The disk library is used only when the host is installed; otherwise the panel
  stays on IndexedDB and the footer says "Local only". Records in the two
  stores are not migrated into each other.
- Uninstalling the extension deletes its IndexedDB fallback. Documents in the
  on-disk library are untouched.
- `file://` pages require **Allow access to file URLs** in the extension details page.

The core storage, messaging, and injection flow is working; the areas above are the main candidates for future work.
