# NookEdit Desktop

Native document app built with Tauri 2, React, and TypeScript. Phase 2 is the
library-first shell: choose a folder, import documents, and manage them. The
editor and PDF viewer land in Phase 3.

The on-disk format is specified in
[`docs/library-format.md`](../../../docs/library-format.md). The Rust
implementation in `src-tauri/src/library.rs` is the native side; the JavaScript
implementation in `@nooksuite/core` is the format spec and the IndexedDB
fallback used by NookBin.

## What works

1. **Choose a library** — on first run, pick any folder or use
   `Documents\NookSuite`. The path is remembered in the app config directory.
2. **Import** — use the Import button or drop files anywhere in the window.
   Files are copied into `documents/<id>/` and added to `library.json`.
   Duplicate names get a ` (2)` suffix instead of overwriting.
3. **Manage** — rename a document in place (its file is renamed too) or delete
   it (its folder is removed). Every change is written through a
   temp-then-rename of `library.json`.
4. **Reopen** — the app opens the saved library on launch and shows what is on
   disk, including documents added by another NookSuite tool.

## Prerequisites

- Node 20+ (installed in this workspace at `%LOCALAPPDATA%\nodejs`)
- Rust + Cargo (`rustup`)
- MSVC C++ Build Tools (Visual Studio Build Tools with the C++ workload)

Without Rust/MSVC, `npm run dev:web` still serves the frontend in a normal
browser, but the library needs the Tauri window.

## Commands

```bash
npm install                 # from the repo root
npm run dev:web             # browser-only frontend (Vite)
npm run tauri dev           # real Tauri window (needs Rust + MSVC)
npm run tauri build         # release build, embeds dist into the exe
npm run spike:fixture       # regenerate public/fixtures/100-pages.pdf
npm run spike:headless      # PDF benchmark + library check, writes JSON, exits
```

`predev:web` and `prebuild` regenerate the PDF fixture automatically.

The `dev:web` name is deliberate: the root `npm run dev` runs every workspace's
`dev` script in watch mode, and a long-running Vite server there would block it.
`npm run tauri dev` starts `dev:web` itself through `beforeDevCommand`.

## Headless check

`spike:headless` runs inside a real WebView2 window without clicking. The app
reads `NOOKEDIT_HEADLESS_REPORT` on launch and exits after writing the report.
The script also sets `NOOKEDIT_HEADLESS_LIBRARY_ROOT`, so the run:

- renders the 100-page PDF benchmark,
- creates a library in a temp folder,
- imports a file, renames it, reopens the library, and confirms the record
  survived,
- writes both results to JSON.

```bash
npm run tauri build         # once; the headless run uses the release exe
npm run spike:headless
npm run spike:headless -- --skip-library   # PDF benchmark only
npm run spike:headless -- --debug          # force the debug build
```

## Implementation notes

- `src-tauri/src/library.rs` — format v1: record validation, name
  normalization, ids, timestamps, atomic writes, and import/rename/remove.
- `src-tauri/src/settings.rs` — `settings.json` in the Tauri config directory.
- `src-tauri/src/lib.rs` — Tauri commands (`open_library`, `import_documents`,
  `rename_document`, `remove_document`, `default_library_path`, settings, and
  the headless entry points).
- `src/lib/api.ts` — typed wrappers for those commands.
- `src/LibraryView.tsx` / `src/DocumentRow.tsx` / `src/SetupView.tsx` — the UI.
- `src/pdf-benchmark.ts` — the P0 pdf.js benchmark, kept for the headless run.

Both implementations parse
`packages/core/tests/fixtures/library-v1.json` in their test suites. If a field
name or validation rule drifts, one side fails.

## Layout

```text
desktop/
├── src/                    # React app
│   └── lib/                # API wrappers, formatting, errors
├── scripts/                # PDF fixture generator, headless launcher, icon.svg
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs          # Tauri commands and headless checks
│   │   ├── library.rs      # on-disk format v1
│   │   └── settings.rs     # remembered library path
│   └── icons/              # generated from scripts/icon.svg
├── index.html
├── vite.config.ts
└── tsconfig.json
```

## Icons

`src-tauri/icons/` is generated from `scripts/icon.svg`:

```bash
npm run tauri -- icon scripts/icon.svg
```

The generator also writes `icons/android/` and `icons/ios/`; those were deleted
because this app is Windows-first. Keep the desktop PNGs, `icon.ico`, and
`icon.icns`.
