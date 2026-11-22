# NookEdit Desktop (P0 spike)

Tauri 2 + React + TypeScript shell for the Phase 0 spikes. The UI is a
throwaway harness; the real app lands in Phase 2.

## What it tests

1. **Filesystem spike** — pick a folder, then create a dot-directory
   (`.nooksuite/`), nested directories (`documents/<id>/`), an atomic
   temp-then-rename write (`library.json`), and read the result back.
2. **pdf.js benchmark** — render all 100 pages of a generated PDF to canvases
   and report total time, per-page time, pages/sec, and JS heap use.

## Prerequisites

- Node 20+ (installed in this workspace at `%LOCALAPPDATA%\nodejs`)
- Rust + Cargo (`rustup`)
- MSVC C++ Build Tools (Visual Studio Build Tools with the C++ workload)

Without Rust/MSVC, `npm run dev:web` still works in a normal browser for the PDF
benchmark; the filesystem button will report that Tauri is unavailable.

## Commands

```bash
npm install                 # from the repo root
npm run spike:fixture       # generate public/fixtures/100-pages.pdf
npm run dev:web             # browser-only harness (Vite)
npm run tauri dev           # real Tauri window (needs Rust + MSVC)
```

`predev:web` and `prebuild` regenerate the PDF fixture automatically.

The `dev:web` name is deliberate: the root `npm run dev` runs every workspace's
`dev` script in watch mode, and a long-running Vite server there would block it.
`npm run tauri dev` starts `dev:web` itself through `beforeDevCommand`.

## Layout

```
desktop/
├── src/                    # React harness
├── scripts/                # PDF fixture generator + icon.svg source
├── src-tauri/              # Rust shell, run_fs_spike command, generated icons
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
