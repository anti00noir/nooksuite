# P0 spike — NookEdit

Phase 0 is a go/no-go check for the assumptions behind the NookEdit plan. It
produces no production code; the harnesses here are throwaway.

## Environment (recorded 2026-11-22)

| Tool | Status |
| --- | --- |
| Node.js | ✅ v26.13.1 LTS at `%LOCALAPPDATA%\nodejs` (per-user, no admin) |
| npm | ✅ 11.20.0 |
| Rust / Cargo | ✅ 1.100.0 stable-x86_64-pc-windows-msvc at `%USERPROFILE%\.cargo\bin` |
| MSVC C++ Build Tools | ✅ 17.14.45, toolset 14.44.35207, Windows SDK 10.0.26100.0 |
| WebView2 runtime | ✅ 157.0.4341.60 |
| Edge | ✅ installed (use for the FSA extension test) |
| Chrome | ❌ not installed |

> Spikes B and C are now runnable. Spike A still needs a manual extension load.

## Spike A — File System Access API in extension contexts

**Question:** can NookBin use a shared library folder via FSA, and can the
in-page panel do the file I/O?

**Harness:** [`spikes/p0/fsa-extension`](../../../spikes/p0/fsa-extension/).

### Why this matters

Chromium blocks the picker in cross-origin iframes:

> `SecurityError: Cross origin sub frames aren't allowed to show a file picker.`

The NookBin panel is an extension-origin iframe embedded in a web page, so it
is a third-party context. The spec also blocks `requestPermission()` there.
The likely workaround is to pick the folder once in a **top-level extension
page**, persist the handle in IndexedDB, and let the panel reuse it.

### How to run

1. Open `edge://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `spikes/p0/fsa-extension`.
3. Click the NookSuite toolbar icon to open the popup.
4. Work through the matrix below, then fill in the results table.

### Test matrix

| # | Context | Action | Expected |
| --- | --- | --- | --- |
| A1 | Popup | Pick folder | Popup may close when the native picker opens; record what happens |
| A2 | Top-level page (`Open full-page test`) | Pick folder → write test | Picker works; handle persists; write test passes |
| A3 | Top-level page | Reload the page → load handle | Handle loads from IndexedDB; permission is `granted` or `prompt` |
| A4 | Injected iframe on `https://example.com` | Pick folder | `SecurityError` (cross-origin subframe) |
| A5 | Same iframe | Load saved handle | Handle loads (same extension origin) |
| A6 | Same iframe | Request permission | Likely blocked in a third-party context |
| A7 | Same iframe | Write test | Works if permission is already `granted`; otherwise fails |
| A8 | Restart Edge, reopen iframe | Load handle → write test | Tests whether permission survives a restart without a top-level re-grant |

Use a permissive page such as `https://example.com` for the iframe test; a
strict site CSP may block `chrome-extension:` frames independently.

### Results

| # | Result | Notes |
| --- | --- | --- |
| A1 | _pending_ | |
| A2 | _pending_ | |
| A3 | _pending_ | |
| A4 | _pending_ | |
| A5 | _pending_ | |
| A6 | _pending_ | |
| A7 | _pending_ | |
| A8 | _pending_ | |

### Decision rule

- **Go (live FSA folder mode)** if A2/A3 pass and A5 + A7 work after a top-level
  grant. Phase 5 then needs a top-level "Library setup" page plus a
  re-grant flow.
- **Go with changes** if the iframe can only read a pre-granted handle but not
  re-request permission. Add an offscreen document for I/O and a visible setup
  page for grants.
- **No-go** if the iframe cannot use the handle at all. Fall back to native
  messaging (Plan A) for the shared library.

## Spike B — Tauri filesystem access

**Question:** can the native app create the library layout in a user-picked
folder, including dot-directories, nested directories, and atomic writes?

**Harness:** [`tools/nookedit/desktop`](../../../tools/nookedit/desktop/).

### How to run

1. Install Rust (`rustup`) and MSVC Build Tools with the C++ workload.
2. From the repo root: `npm install`.
3. `npm run tauri dev --workspace @nooksuite/nookedit-desktop`.
4. Click **Pick folder and run** and choose an empty folder.

### What to record

- Did the folder picker open?
- Were `.nooksuite/`, `documents/<id>/`, and `library.json` created?
- Did the temp-then-rename write leave exactly one `library.json`?
- Did the read-back match?
- Any antivirus / Defender prompts or permission errors?

### Results

| Check | Result | Notes |
| --- | --- | --- |
| Folder picker | _pending_ | Needs the native dialog in a real Tauri window |
| Dot-directory | ✅ Rust test | `.nooksuite/` created and asserted |
| Nested directories | ✅ Rust test | `documents/<id>/` created and asserted |
| Atomic write | ✅ Rust test | Temp-then-rename leaves one `library.json` with the exact bytes |
| Read-back | ✅ Rust test | JSON parses; `schemaVersion: 1`, `spike: true` |

`cargo test` exercises `run_fs_spike` against a temp directory, so the file
layout and write semantics are verified. What the tests cannot cover is the
native folder picker and any Defender/antivirus prompts on a real folder.

## Spike C — pdf.js performance on WebView2

**Question:** is pdf.js fast enough to render a 100-page PDF in WebView2?

**Harness:** the same Tauri app, second card.

### How to run

- Browser proxy: `npm run dev:web --workspace @nooksuite/nookedit-desktop`, open
  `http://localhost:1420`, click **Run PDF benchmark**.
- Real target: `npm run tauri dev --workspace @nooksuite/nookedit-desktop`,
  click the same button (this runs in WebView2).

The fixture is generated by `scripts/generate-fixture.mjs` (100 pages, text
only, 612×792).

### Results

| Environment | Pages | First page | Total | Per page | Pages/sec | JS heap |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 152 (in-app browser, proxy) | 100 | 4,058 ms | 14,459 ms | 144.6 ms | 6.9 | 20.0 MB |
| WebView2 157 (Tauri) | _pending_ | | | | | |

> **Proxy is inconclusive.** The first run after opening the tab measured
> **1,749 ms total / 17.5 ms per page / 57.2 pages per second**; later runs
> measured 14–34 s for the same fixture. The in-app browser throttles
> rendering when its window is occluded, so this number is not a valid
> go/no-go signal. Measure in the Tauri window instead.

### Decision rule

- **Go** if first-page render is under ~150 ms and 100 pages render in under
  ~5 s in WebView2. Virtualization means only a few pages render at once in
  the real app.
- **Investigate** if per-page time is above ~100 ms; consider PDFium via Rust
  instead of pdf.js for the viewer.

## Harness validation (2026-11-22)

- `npm install` from the repo root: OK.
- `npm run build`: website, NookBin extension, and NookEdit frontend all build.
- `npm test`: 29/29 core tests pass.
- FSA spike scripts pass `node --check`; manifest and Tauri configs parse as
  JSON.
- The pdf.js benchmark completes with no console errors in Chromium.
- `cargo test` (Rust 1.100.0 + MSVC 14.44): 2/2 pass — the filesystem spike
  creates `.nooksuite/`, `documents/<id>/`, and a byte-identical `library.json`,
  and rejects a missing directory.
- `npm run tauri icon` generates the Windows resource icon from
  `scripts/icon.svg`.

## Go/no-go summary

| Spike | Verdict | Date |
| --- | --- | --- |
| A — FSA | _pending_ — harness ready, needs a manual Edge run | |
| B — Tauri fs | _partial_ — file layout/write semantics verified by test; picker pending | |
| C — pdf.js | _inconclusive in proxy; WebView2 pending_ | |

## Reproducing

```bash
# From the repo root
npm install
npm run spike:fixture --workspace @nooksuite/nookedit-desktop
npm run build --workspace @nooksuite/nookedit-desktop
```
