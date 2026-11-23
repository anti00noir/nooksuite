import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SCHEMA_VERSION,
  createLibraryFile,
  createRecord,
  listRecords,
  parseLibraryFile,
  removeRecord,
  serializeLibraryFile,
  upsertRecord,
} from '../src/index.js';

function libraryWith(...names) {
  let library = createLibraryFile({ now: '2026-01-01T00:00:00.000Z' });
  const records = [];

  for (const name of names) {
    const record = createRecord({
      name,
      size: name.length,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    records.push(record);
    library = upsertRecord(library, record);
  }

  return { library, records };
}

describe('createLibraryFile', () => {
  it('creates an empty index with the current schema version', () => {
    const library = createLibraryFile({ now: '2026-01-01T00:00:00.000Z' });

    assert.equal(library.schemaVersion, SCHEMA_VERSION);
    assert.match(library.libraryId, /^lib_[0-9a-z]{10}$/);
    assert.equal(library.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(library.updatedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(library.records, {});
  });
});

describe('serializeLibraryFile / parseLibraryFile', () => {
  it('round-trips a library', () => {
    const { library } = libraryWith('a.txt', 'b.pdf');
    const parsed = parseLibraryFile(serializeLibraryFile(library));

    assert.deepEqual(parsed, library);
  });

  it('ends the file with a newline', () => {
    const text = serializeLibraryFile(createLibraryFile());
    assert.ok(text.endsWith('}\n'));
  });

  it('accepts an already-parsed object', () => {
    const library = createLibraryFile();
    assert.deepEqual(parseLibraryFile(library), library);
  });

  it('drops unknown top-level fields', () => {
    const library = { ...createLibraryFile(), extra: true };
    assert.equal('extra' in parseLibraryFile(library), false);
  });

  it('rejects a non-object', () => {
    assert.throws(() => parseLibraryFile('[]'), /must contain a JSON object/);
    assert.throws(() => parseLibraryFile('null'), /must contain a JSON object/);
    assert.throws(() => parseLibraryFile('"text"'), /must contain a JSON object/);
  });

  it('rejects a missing or non-integer schema version', () => {
    assert.throws(() => parseLibraryFile({}), /integer schemaVersion/);
    assert.throws(
      () => parseLibraryFile({ schemaVersion: '1' }),
      /integer schemaVersion/,
    );
  });

  it('rejects a newer schema version', () => {
    assert.throws(
      () => parseLibraryFile({ ...createLibraryFile(), schemaVersion: 2 }),
      /supports up to 1/,
    );
  });

  it('rejects an invalid library id', () => {
    assert.throws(
      () => parseLibraryFile({ ...createLibraryFile(), libraryId: 'nope' }),
      /Invalid library id/,
    );
  });

  it('rejects a records array', () => {
    assert.throws(
      () => parseLibraryFile({ ...createLibraryFile(), records: [] }),
      /records must be an object/,
    );
  });

  it('rejects a record whose key does not match its id', () => {
    const record = createRecord({ name: 'a.txt' });
    const library = createLibraryFile();
    library.records.other = record;

    assert.throws(() => parseLibraryFile(library), /mismatched id/);
  });

  it('rejects a malformed record', () => {
    const library = createLibraryFile();
    library.records[`doc_abcdefghij`] = { id: `doc_abcdefghij`, name: 'a/b.txt' };

    assert.throws(() => parseLibraryFile(library), /Invalid document name/);
  });
});

describe('upsertRecord', () => {
  it('adds a record and takes its updatedAt', () => {
    const library = createLibraryFile({ now: '2026-01-01T00:00:00.000Z' });
    const record = createRecord({
      name: 'a.txt',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const next = upsertRecord(library, record);

    assert.equal(next.records[record.id], record);
    assert.equal(next.updatedAt, '2026-01-02T00:00:00.000Z');
    assert.notEqual(next, library);
  });

  it('replaces a record with the same id', () => {
    const { library, records } = libraryWith('a.txt');
    const [record] = records;
    const renamed = { ...record, name: 'b.txt', path: `documents/${record.id}/b.txt` };

    const next = upsertRecord(library, renamed);

    assert.equal(Object.keys(next.records).length, 1);
    assert.equal(next.records[record.id].name, 'b.txt');
  });
});

describe('removeRecord', () => {
  it('removes by id and bumps updatedAt', () => {
    const { library, records } = libraryWith('a.txt', 'b.txt');
    const next = removeRecord(library, records[0].id, {
      now: '2026-02-01T00:00:00.000Z',
    });

    assert.equal(Object.keys(next.records).length, 1);
    assert.equal(next.records[records[1].id], records[1]);
    assert.equal(next.updatedAt, '2026-02-01T00:00:00.000Z');
  });

  it('is a no-op for an unknown id', () => {
    const library = createLibraryFile();
    assert.equal(removeRecord(library, 'doc_unknown000'), library);
  });
});

describe('listRecords', () => {
  it('sorts case-insensitively by name', () => {
    const { library } = libraryWith('b.txt', 'A.txt', 'c.txt');
    const names = listRecords(library).map((record) => record.name);

    assert.deepEqual(names, ['A.txt', 'b.txt', 'c.txt']);
  });
});
