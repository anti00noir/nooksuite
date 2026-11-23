# Library format v1

NookEdit and NookBin share one on-disk library. This document is the contract
between them: the native app reads and writes it directly, and the extension
uses the same record shape for its IndexedDB fallback.

The format lives in `@nooksuite/core` (`packages/core/src/library/`). The native
app mirrors it in `tools/nookedit/desktop/src-tauri/src/library.rs`, and both
sides parse the shared fixture
`packages/core/tests/fixtures/library-v1.json` in their tests.

## Layout

```text
<library>/
├── .nooksuite/
│   └── library.json
└── documents/
    └── <id>/
        └── <name>
```

- The library root is user-configurable; the default is
  `Documents\NookSuite`.
- `.nooksuite/` is reserved for suite metadata. The leading dot keeps it out of
  the way in Explorer and on Unix.
- `documents/<id>/` is the record's folder. Bytes keep their original name, so
  a user browsing the folder sees readable files.
- The native app owns the library today; the native messaging host will reuse
  the same implementation. Writes go through a temp-then-rename for
  `library.json`, so a reader never observes a partial index.

## `library.json`

One file holds every record. Listing the library is a single read; the bytes
stay next to the index.

```json
{
  "schemaVersion": 1,
  "libraryId": "lib_9f2k1m4x7q",
  "createdAt": "2026-11-23T10:12:04.512Z",
  "updatedAt": "2026-11-23T10:14:31.908Z",
  "records": {
    "doc_4r8m2c9t1v": {
      "id": "doc_4r8m2c9t1v",
      "name": "Quarterly report.pdf",
      "mediaType": "application/pdf",
      "size": 482113,
      "path": "documents/doc_4r8m2c9t1v/Quarterly report.pdf",
      "createdAt": "2026-11-23T10:12:04.512Z",
      "updatedAt": "2026-11-23T10:12:04.512Z"
    }
  }
}
```

`records` is an object keyed by id rather than an array. That makes lookups and
upserts O(1), keeps the file diff-friendly when one record changes, and makes a
duplicated key impossible.

### Top-level fields

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | integer | Currently `1`. A reader refuses a newer version. |
| `libraryId` | string | `lib_` + 10 base-36 characters. Stable for the life of the library. |
| `createdAt` | ISO 8601 string | When the index was created. |
| `updatedAt` | ISO 8601 string | Last record change. |
| `records` | object | Record id → record. |

Unknown top-level fields are dropped when parsing, so adding metadata later does
not require a reader update. Records are validated strictly.

### Record fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `doc_` + 10 base-36 characters. |
| `name` | string | Display name and file name on disk. |
| `mediaType` | string | Inferred from the extension when not supplied. |
| `size` | integer | Bytes. Updated when a text document is saved. |
| `path` | string | Always `documents/<id>/<name>`. |
| `createdAt` | ISO 8601 string | |
| `updatedAt` | ISO 8601 string | Bumped by rename and by a text edit. |

`path` is stored rather than derived at read time so a record is self-describing
in logs and diffs. `parseLibraryFile` rejects a record whose `path` disagrees
with its `id` and `name`, which catches hand-edited or partially written
indexes.

## Ids

Ids are opaque, filesystem-safe, and generated locally:

```text
doc_9f2k1m4x7q
lib_3p0a8s5d2w
```

They are random rather than sequential so two devices importing the same file
cannot mint the same id for different documents. A collision is still possible
in principle; the native host must check for an existing folder before
committing a new record.

## Names

`normalizeName()` turns any input into a safe file name:

- `/ \ : * ? " < > |` and control characters become `-`.
- Runs of whitespace collapse to one space; leading and trailing whitespace is
  trimmed.
- Leading dots are stripped (no hidden files, no `.`/`..`).
- Trailing dots and spaces are stripped because Windows rejects them.
- Names are capped at 120 characters.
- An empty result becomes `untitled`.

Names must be unique within a library. Comparison is case-insensitive because
the default location is on a case-insensitive filesystem. `uniqueName()` adds
` (2)`, ` (3)`, … before the extension:

```text
report.pdf  →  report (2).pdf
notes       →  notes (2)
```

This differs from the pre-Phase-1 extension store, where a second file with the
same name replaced the first.

## Versioning

- A reader accepts `schemaVersion <= 1`.
- A newer version is a hard error: the reader cannot know what changed, and
  guessing risks corrupting a library written by a newer build.
- Version 1 has no migration path yet. When the shape changes, add a stepwise
  upgrade in `parseLibraryFile` and write the result back at the current
  version.

## IndexedDB fallback

When NookEdit is not installed, NookBin keeps using IndexedDB in the extension
origin. It stores the same records, so the UI and the record model do not
diverge:

- Database: `my-files` (unchanged, so existing data is found)
- Version: `2`
- `records` — keyPath `id`
- `blobs` — keyed by id, so listing never deserializes file bytes
- `meta` — migration bookkeeping

Bytes are kept in a separate store from metadata. Listing the library reads only
`records`.

### Migrating from version 1

Version 1 stored `name -> Blob` in a single `files` store, so duplicate names
had already overwritten each other. On first open, version 2:

1. Reads every `files` entry.
2. Plans records for the entries whose values are `Blob`s, giving duplicate
   names the usual ` (2)` suffix.
3. Writes the records and blobs.
4. Deletes only the legacy keys that were migrated, so values the migration
   cannot handle stay in place.
5. Records the result in `meta` under `legacyFilesMigrated`, so it runs once.

The legacy store is left in the database but empty. Removing it would require
another version bump and buys nothing.
