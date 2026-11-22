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
| A1 | ✅ pass | Popup picker works and the popup **stays open** while the dialog is shown; permission `granted` |
| A2 | ✅ pass | `Picked "fsa-spike-test"`, permission `granted`, handle saved |
| A3 | ✅ pass | After reload the handle loads, but permission is back to `prompt` |
| A4 | ✅ blocked, as predicted | `NotAllowedError: Third party iframes are not allowed to show a file picker` |
| A5 | ✅ pass | Handle loads inside the iframe (same extension origin) |
| A6 | ✅ blocked, as predicted | `SecurityError: Not allowed to request permissions in a third-party context` |
| A7 | ❌ blocked | Write test stops at the permission gate; state never leaves `prompt` |
| A8 | ❌ no persistence | After a full Edge restart the iframe still loads the handle at `prompt`, still cannot request, still cannot write |

### What this means

The grant is **per document, not per origin**. A2 grants `readwrite`, but a
reload of the same top-level page reports `prompt` again (A3), and a full
browser restart changes nothing (A8). The iframe never sees `granted` (A5) and
cannot escalate, because `requestPermission()` is rejected in a third-party
context (A6). So A7 cannot pass: the panel can read the handle but can never
read file contents or write with it.

That kills the "pick once at top level, reuse forever in the panel" design:

- The **in-page panel cannot perform FSA I/O at all** — not reads of file
  contents (permission is `prompt`), and certainly not writes.
- A top-level **Library tab** can do the I/O, but needs a user-gesture grant
  after every load (A3, A8), so it is "one click per page load", not "once
  ever". The panel would have to message that tab through the background
  worker.
- Native messaging, or letting the native app own the library, avoids the
  permission model entirely.

A1 is worth noting: the toolbar popup can pick a folder and **stays open**
while the native dialog is up, so a popup is a viable place to acquire a grant
— it is just a short-lived one, and a popup cannot hold a library session.

Note: Chromium reported `NotAllowedError` for the iframe picker, not the
`SecurityError` the earlier NookBin test produced. Both mean "blocked"; the
error type is not a stable signal.

### Decision rule (as written before the run)

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
| Folder picker | ✅ verified | Native dialog opened; the chosen folder received the library |
| Dot-directory | ✅ verified | Rust test **and** the headless run in a WebView2 window |
| Nested directories | ✅ verified | Same |
| Atomic write | ✅ verified | Temp-then-rename leaves one `library.json` with the exact bytes |
| Read-back | ✅ verified | JSON parses; `schemaVersion: 1`, `spike: true` |

A manual run against `Desktop\fsa-spike-test` produced
`.nooksuite\library.json` and `documents\spike-4420\hello.txt`, with
`hiddenDir=true`, `nestedDirs=true`, `atomicWrite=true`, and the document
reading back as `hello from the Tauri fs spike`.

`cargo test` exercises `run_fs_spike` against a temp directory, and
`npm run spike:headless` exercises the same command through the real Tauri IPC
bridge in a WebView2 window. The manual run covers the one thing neither could:
the native folder picker.

## Spike C — pdf.js performance on WebView2

**Question:** is pdf.js fast enough to render a 100-page PDF in WebView2?

**Harness:** the same Tauri app, second card.

### How to run

- Browser proxy: `npm run dev:web --workspace @nooksuite/nookedit-desktop`, open
  `http://localhost:1420`, click **Run PDF benchmark**.
- Real target, manually: `npm run tauri dev --workspace @nooksuite/nookedit-desktop`,
  click the same button (this runs in WebView2).
- Real target, headless: `npm run tauri build --workspace @nooksuite/nookedit-desktop`
  once, then `npm run spike:headless --workspace @nooksuite/nookedit-desktop`.
  The app renders the benchmark on launch, writes a JSON report, and exits, so
  no clicking is needed.

The fixture is generated by `scripts/generate-fixture.mjs` (100 pages, text
only, 612×792).

### Results

| Environment | Pages | First page | Total | Per page | Pages/sec | JS heap |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 152 (in-app browser, proxy) | 100 | 4,058 ms | 14,459 ms | 144.6 ms | 6.9 | 20.0 MB |
| **WebView2 157 (Tauri, headless)** | **100** | **87 ms** | **1,747 ms** | **17.5 ms** | **57.2** | **7.4 MB** |
| WebView2 157 (Tauri, manual `tauri dev`) | 100 | 44 ms | 1,699 ms | 17.0 ms | 58.9 | 16.4 MB |

> **Verdict: go.** Two independent WebView2 runs agree: first page 44–87 ms
> (limit ~150 ms), 100 pages in 1.70–1.75 s (limit ~5 s), 17.0–17.5 ms per page
> (investigate threshold ~100 ms). The headless run also matches the first
> Chromium proxy run almost exactly (1,749 ms), which confirms that measurement
> was real and the later 14–34 s proxy runs were occlusion throttling, not a
> pdf.js problem.
>
> The manual `tauri dev` run reports a larger JS heap (16.4 MB vs 7.4 MB)
> because the dev build keeps DevTools and React's development bundle loaded.
>
> Real usage is lighter still: the viewer virtualizes, so only the visible
> pages render.

Measured with `npm run spike:headless` (report in
`%TEMP%\nookedit-headless-*`). The same run also exercised the filesystem
spike through the real IPC bridge in a WebView2 window:
`hiddenDir=true nestedDirs=true atomicWrite=true`.

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
- `npm run tauri build` produces `target/release/nookedit.exe` (7m27s cold).
- `npm run spike:headless` runs both spikes in WebView2, writes a JSON report,
  and exits without user interaction. WebView2 157 reports itself as
  `Edg/157.0.0.0`.

## Go/no-go summary

| Spike | Verdict | Date |
| --- | --- | --- |
| A — FSA | ❌ **no-go for in-panel I/O** — permission is per-document and cannot be escalated in a third-party iframe; fall back to a Library tab or native messaging | 2026-11-22 |
| B — Tauri fs | ✅ **go** — picker, dot-directory, nested directories, atomic write, and read-back all verified in the app | 2026-11-22 |
| C — pdf.js | ✅ **go** — 44–87 ms first page, 1.70–1.75 s for 100 pages, ~17 ms/page in WebView2 | 2026-11-22 |

## Reproducing

```bash
# From the repo root
npm install
npm run spike:fixture --workspace @nooksuite/nookedit-desktop
npm run build --workspace @nooksuite/nookedit-desktop

# Rust filesystem tests (needs Rust + MSVC)
cargo test --manifest-path tools/nookedit/desktop/src-tauri/Cargo.toml

# WebView2 benchmark, no clicking (needs a build first)
npm run tauri build --workspace @nooksuite/nookedit-desktop
npm run spike:headless --workspace @nooksuite/nookedit-desktop
```
