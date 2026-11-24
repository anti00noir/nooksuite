import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseLibraryFile, serializeLibraryFile } from '../src/index.js';

// Shared with the Rust implementation in
// crates/nooksuite-library/src/library.rs. If either side changes a
// field name or a validation rule, one of the two test suites fails.
const FIXTURE_URL = new URL('./fixtures/library-v1.json', import.meta.url);

function readFixture() {
  return readFileSync(FIXTURE_URL, 'utf8');
}

describe('library v1 fixture', () => {
  it('parses with the core implementation', () => {
    const library = parseLibraryFile(readFixture());

    assert.equal(library.schemaVersion, 1);
    assert.equal(library.libraryId, 'lib_fixture001');
    assert.deepEqual(Object.keys(library.records).sort(), [
      'doc_fixture001',
      'doc_fixture002',
    ]);
    assert.equal(library.records.doc_fixture001.name, 'Quarterly report.pdf');
    assert.equal(
      library.records.doc_fixture002.path,
      'documents/doc_fixture002/notes (2).md',
    );
  });

  it('round-trips through the serializer unchanged', () => {
    const library = parseLibraryFile(readFixture());
    const reparsed = parseLibraryFile(serializeLibraryFile(library));

    assert.deepEqual(reparsed, library);
  });
});
