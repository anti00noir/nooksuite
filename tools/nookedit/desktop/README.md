# NookEdit Desktop

Native document app built with Tauri 2, React, and TypeScript. Phase 3 opens
documents from the library: text and Markdown get a CodeMirror editor (with a
Markdown preview), PDFs get a pdf.js viewer, and every format can be exported.
PDF page operations and annotations come later.

The on-disk format is specified in
[`docs/library-format.md`](../../../docs/library-format.md). The Rust
implementation in
[`crates/nooksuite-library`](../../../crates/nooksuite-library) is the native
side, shared with the native messaging host that NookBin uses. The JavaScript
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
4. **Open and edit** — click a document:
   - `.txt`, `.md`, and other text-like files open in CodeMirror. Markdown has a
     rendered preview. `Ctrl+S` saves; the record's size and `updatedAt` follow.
   - PDFs open in a canvas viewer with page navigation, zoom, fit-width, and
     fit-page. Page operations are Phase 5.
   - Images show inline.
   - Other formats show metadata and an export button.
5. **Export** — save a copy anywhere. Text and Markdown export the current
   editor contents, even before saving; PDFs and images copy their bytes.
6. **Reopen** — the app opens the saved library on launch and shows what is on
   disk, including documents added by another NookSuite tool.

Unsaved edits are guarded when leaving the editor. Closing the window while
dirty is not guarded yet.

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
npm run spike:headless      # benchmark + library + IPC + PDF checks, writes JSON
```

`predev:web` and `prebuild` regenerate the PDF fixture automatically.

The `dev:web` name is deliberate: the root `npm run dev` runs every workspace's
`dev` script in watch mode, and a long-running Vite server there would block it.
`npm run tauri dev` starts `dev:web` itself through `beforeDevCommand`.

## Headless check

`spike:headless` runs inside a real WebView2 window without clicking. The app
reads `NOOKEDIT_HEADLESS_REPORT` on launch and exits after writing the report.
The script also sets `NOOKEDIT_HEADLESS_LIBRARY_ROOT` and
`NOOKEDIT_HEADLESS_PDF_PATH`, so the run:

- renders the 100-page PDF benchmark,
- creates a library in a temp folder,
- imports a file, renames it, edits it, exports it, reopens the library, and
  confirms the record and text survived,
- reads text and raw bytes over IPC and saves through the same command the UI
  uses,
- imports the PDF fixture and renders page one from the bytes IPC returned,
- writes all results to JSON.

```bash
npm run tauri build         # once; the headless run uses the release exe
npm run spike:headless
npm run spike:headless -- --skip-library   # PDF benchmark only
npm run spike:headless -- --debug          # force the debug build
```

## Implementation notes

- `../../../crates/nooksuite-library/src/library.rs` — format v1: record
  validation, name normalization, ids, timestamps, atomic writes, and
  import/rename/remove plus text reads, text saves, exports, and ranged reads.
  Shared with the native messaging host.
- `../../../crates/nooksuite-library/src/settings.rs` — `settings.json` in the
  app config directory; the host reads the same file.
- `src-tauri/src/lib.rs` — Tauri commands (`open_library`, `import_documents`,
  `rename_document`, `remove_document`, `read_document_text`,
  `read_document_bytes`, `save_document`, `export_document`,
  `default_library_path`, settings, and the headless entry points).
- `src/lib/api.ts` — typed wrappers for those commands.
- `src/LibraryView.tsx` / `src/DocumentRow.tsx` / `src/SetupView.tsx` — the
  library UI.
- `src/DocumentView.tsx` — the open-document shell, save/export, and dirty
  handling.
- `src/TextEditor.tsx` — CodeMirror 6; `src/MarkdownPreview.tsx` — rendered
  Markdown.
- `src/PdfViewer.tsx` — pdf.js canvas viewer; `src/ImagePreview.tsx` — image
  previews.
- `src/pdf-benchmark.ts` — the P0 pdf.js benchmark, kept for the headless run.

`read_document_bytes` returns `tauri::ipc::Response`, so pdf.js receives an
`ArrayBuffer` rather than a JSON number array.

The editor, PDF viewer, and Markdown renderer are lazy-loaded, so the library
screen does not pay for them on launch.

Both implementations parse
`packages/core/tests/fixtures/library-v1.json` in their test suites. If a field
name or validation rule drifts, one side fails.

## Layout

```text
desktop/
├── src/                    # React app
│   └── lib/                # API wrappers, formatting, errors, PDF setup
├── scripts/                # PDF fixture generator, headless launcher, icon.svg
├── src-tauri/
│   ├── src/
│   │   └── lib.rs          # Tauri commands and headless checks
│   └── icons/              # generated from scripts/icon.svg
├── index.html
├── vite.config.ts
└── tsconfig.json
```

The format and settings code it links live one level up the repository, in
`crates/nooksuite-library/`. The host that serves NookBin is in
`tools/nookedit/host/`.

## Icons

`src-tauri/icons/` is generated from `scripts/icon.svg`:

```bash
npm run tauri -- icon scripts/icon.svg
```

The generator also writes `icons/android/` and `icons/ios/`; those were deleted
because this app is Windows-first. Keep the desktop PNGs, `icon.ico`, and
`icon.icns`.
