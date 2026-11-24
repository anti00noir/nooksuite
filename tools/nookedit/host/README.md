# NookSuite Native Host

Native messaging host that gives NookBin the on-disk library NookEdit uses.
Chrome starts this process when the extension calls
`chrome.runtime.connectNative("dev.nooksuite.host")`; it speaks Chrome's
length-prefixed JSON protocol over stdin/stdout.

The library implementation lives in
[`crates/nooksuite-library`](../../../crates/nooksuite-library), the same crate
the desktop app builds. The host is a thin protocol layer on top of it.

## Library location

In order:

1. `NOOKSUITE_LIBRARY_ROOT` (used by the check script and tests),
2. the `libraryPath` NookEdit saved in `settings.json` in the app config
   directory,
3. `Documents\NookSuite`.

The host creates the folder on first use. It never writes settings; NookEdit
owns the picker.

## Protocol

Every message is a 4-byte little-endian length followed by one UTF-8 JSON
object, in both directions. Requests carry a `requestId` that is echoed back;
`id` is a document id.

| Op | Request fields | Response |
| --- | --- | --- |
| `ping` | — | `hostVersion`, `protocolVersion`, `library` |
| `list` | — | `root`, `libraryId`, `records` |
| `import` | `name`, `mediaType`, `data` (base64) | `record` |
| `read` | `id`, `offset`, `length` | `record`, `data` (base64), `offset`, `nextOffset`, `eof` |
| `rename` | `id`, `name` | `record` |
| `remove` | `id` | — |

Success is `{ "requestId": 1, "ok": true, ... }`. Failure is
`{ "requestId": 1, "ok": false, "error": { "code", "message" } }` with a code of
`bad_request`, `not_found`, or `io`.

Reads are chunked because Chrome caps a single message **from** the host at
1 MB. The host sends at most 512 KB of raw bytes per chunk (about 683 KB of
base64). The client keeps asking until `eof` is true. Imports are a single
message; the extension caps them at 32 MB, which is about 43 MB of base64 and
stays under the host's 64 MB per-message limit.

Nothing but protocol frames is written to stdout. Diagnostics go to stderr,
which Chrome records in its native messaging log.

## Commands

```bash
npm run build:host      # cargo build --release
npm run test:host       # cargo test (protocol and dispatch)
npm run host:check      # build, then exercise a real process end to end
npm run host:install    # register with Chrome and Edge
npm run host:uninstall
```

Run these from this folder, or use `--workspace @nooksuite/host` from the repo
root.

## Installing

The host manifest lists the extension ids allowed to connect, so load the
extension first:

1. `npm run build` (repo root) and load `tools/nookbin/extension/dist` in
   `chrome://extensions`.
2. `npm run host:install --workspace @nooksuite/host`.

The installer builds the release binary, copies it to
`%LOCALAPPDATA%\NookSuite\host\`, writes `dev.nooksuite.host.json` next to it,
and points the Chrome and Edge native messaging registry keys at that manifest.

It finds the extension id in the browsers' `Preferences` files by matching the
loaded path. If detection fails, pass the id shown on `chrome://extensions`:

```bash
npm run host:install --workspace @nooksuite/host -- --id=<extension id>
```

Because the id is derived from the unpacked folder's path, it changes if the
extension is moved. Re-run the installer after moving it. A packaged release
would pin the id with a `key` in the manifest instead.

No browser restart is needed: Chrome reads the registration when the extension
connects. Reopen the NookBin panel.

## Limits and safety

- The host processes one request at a time and reopens `library.json` for each
  one, so edits NookEdit makes while it runs are visible and two host processes
  are not the intended setup. The extension talks to it through the background
  service worker, which keeps a single connection per browser profile.
- `allowed_origins` restricts connections to the installed extension id. The
  host trusts its caller to name files and ids; it validates names and ids with
  the same rules as the desktop app.
- The host exits when the browser closes the pipe.

## Layout

```text
host/
├── src/
│   ├── main.rs      # stdin/stdout loop
│   ├── protocol.rs  # framing, dispatch, tests
│   └── config.rs    # library root resolution
├── scripts/
│   ├── check.mjs    # end-to-end protocol check
│   └── install.mjs  # browser registration
└── Cargo.toml
```
