# NookSuite

A suite of small browser tools, structured as an npm-workspaces monorepo. Each
tool lives under `tools/` with one folder per target (browser extension, native
port), and target-agnostic logic lives in `packages/core` so every tool — and
every port of a tool — can reuse it.

## Tools

**NookBin** (`tools/nookbin`) — a Manifest V3 Chrome extension for keeping
frequently used documents in a floating panel and sending them to a file upload
control on the active page. Store a file once, then reuse it without opening
the file picker again.

Current behavior:

1. Click the NookBin toolbar icon, or press **Alt+Shift+N**, to open the floating panel.
2. The panel docks to the right side of the page. Drag its header to move it anywhere, use the dock button to snap it back to the right, or close it with the **×** button.
3. Drop one or more files into the drop guide, or click it (or the header **Add files** button) to browse.
4. Files are stored as records in the shared on-disk library when the native host is installed; otherwise they stay in the extension's IndexedDB. The footer shows which source is active.
5. Search, filter by PDF/Images, or sort the list by name or size.
6. Open a page with an upload form and click the send icon next to a stored file.

The content script finds a file input, attaches the file to it, and fires the events an upload widget normally listens for. If no file input is found, it falls back to simulating a drag-and-drop on an element that looks like an upload area.

Because the panel is rendered inside the page rather than as Chrome's native action popup, it stays on screen when the page enters fullscreen. Its last position is remembered between openings.

On pages where Chrome does not allow content scripts (for example `chrome://` pages, the Chrome Web Store, or the PDF viewer), NookBin opens a movable standalone popup window instead.

**NookEdit** (`tools/nookedit`) — a native document editor (Tauri 2 + React) for
opening, editing, and exporting documents from the same on-disk library NookBin
uses. Planned formats are PDF, plain text, and Markdown; PDF scope is view,
page operations, and annotations/forms rather than text reflow.

NookEdit is at **Phase 3**: the desktop app opens a library folder, imports
documents, and opens them for editing. Text and Markdown use CodeMirror (with a
Markdown preview), PDFs use a pdf.js viewer, and every format can be exported.
The on-disk format is specified in
[`docs/library-format.md`](docs/library-format.md). NookBin now reads the same
library through the native messaging host in `tools/nookedit/host` and falls
back to IndexedDB when the host is not installed. PDF page operations and
annotations are next. See [`docs/architecture.md`](docs/architecture.md) for how
the pieces fit together and
[`docs/spikes/p0/README.md`](docs/spikes/p0/README.md) for the feasibility
results.

See [`docs/architecture.md`](docs/architecture.md) for detailed architecture notes.

## Repository layout

```text
nooksuite/
├── package.json                      # Root: npm workspaces, shared scripts
├── docs/
│   ├── architecture.md               # Suite-wide architecture notes
│   ├── library-format.md             # Shared on-disk library format v1
│   └── spikes/                       # Phase 0 feasibility findings
├── spikes/
│   └── p0/
│       └── fsa-extension/            # Throwaway MV3 extension: FSA context matrix
├── packages/
│   └── core/                         # @nooksuite/core (target-agnostic)
│       ├── src/
│       │   ├── index.js              # Public exports
│       │   ├── panel-position.js     # Floating-panel geometry helpers
│       │   ├── record-storage.js     # Record storage interface + shared rules
│       │   ├── library/              # Library format: ids, records, library.json
│       │   ├── native/               # Native messaging client + library adapter
│       │   └── backends/
│       │       └── idb-record-storage.js  # IndexedDB backend + legacy migration
│       └── tests/                    # node --test unit tests
├── crates/
│   └── nooksuite-library/            # Shared Rust library format v1
├── apps/
│   └── website/                      # @nooksuite/website — overview site
│       ├── site/                     # index.html, css/, data/tools.js, fonts/
│       ├── build.mjs                 # copies site/ → dist/, renders the tool roster
│       └── dist/                     # static output; point any static host here
└── tools/
    ├── nookbin/
    │   └── extension/                # The Chrome MV3 extension
    │       ├── src/
    │       │   ├── manifest.json     # Extension manifest and permissions
    │       │   ├── background.js     # Toolbar/shortcut handling, native bridge
    │       │   ├── content.js        # Floating panel host, file injection
    │       │   ├── native-host.js    # Panel-side native transport
    │       │   ├── popup.js          # Panel logic and storage orchestration
    │       │   ├── popup/            # Panel markup and styles
    │       │   └── fonts/            # Bundled IBM Plex Mono (SIL OFL)
    │       ├── build.mjs             # esbuild: bundles into dist/
    │       └── dist/                 # Build output (Chrome loads this)
    └── nookedit/                     # Native document editor (Tauri 2 + React)
        ├── desktop/                  # Library, text/Markdown editor, PDF viewer
        └── host/                     # Native messaging host + installer
```

## Development

```bash
npm install        # once, from the repo root (workspaces handle the rest)
npm run build      # build every tool's bundles into its dist/
npm run dev        # watch mode; rebuilds on save
npm test           # run every workspace's unit tests
```

Chrome's **Load unpacked** must point at `tools/nookbin/extension/dist/`, not
the source folder. After changes, reload the extension from `chrome://extensions`.

NookBin uses the shared on-disk library when the native host is installed. The
host is a small Rust binary in `tools/nookedit/host`; build and register it
after loading the extension (the installer reads the extension id from the
browser profile):

```bash
npm run build:host --workspace @nooksuite/host
npm run host:check --workspace @nooksuite/host     # end-to-end protocol check
npm run host:install --workspace @nooksuite/host   # Chrome + Edge registration
```

If detection fails, pass the id shown on `chrome://extensions`:
`npm run host:install --workspace @nooksuite/host -- --id=<id>`. Without the
host, the panel falls back to IndexedDB and the footer says "Local only".

The overview website builds alongside the tools: `apps/website/dist/` is a
plain static site with no runtime JavaScript, so you can open its
`index.html` straight from disk or point any static host at that folder. The
tool roster on the page is rendered at build time from
`apps/website/site/data/tools.js` — adding a tool to the site is one data
entry and a rebuild.

The browser tools have no runtime dependencies; the extension ships only its
own code and bundled `@nooksuite/core` logic. `esbuild` is the only build tool,
and unit tests use Node's built-in test runner with `fake-indexeddb`. Rust tests
run through Cargo for `crates/nooksuite-library`, the desktop app, and the host.

The NookEdit desktop workspace is the one exception: it is a Tauri app with its
own React/Vite toolchain, and it builds through the same root scripts. Running
it needs Node, Rust, and the MSVC C++ Build Tools:

```bash
npm run tauri dev --workspace @nooksuite/nookedit-desktop
```

Its `dev:web` script (browser-only harness) is deliberately not named `dev`, so
the root `npm run dev` watch build is not blocked by a long-running dev server.

Adding a new tool means adding `tools/<name>/extension/` with its own manifest
and build script — no changes are needed at the suite level.
