import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_NAME_LENGTH,
  assertValidRecord,
  createDocumentId,
  createLibraryId,
  createRecord,
  guessMediaType,
  isDocumentId,
  isLibraryId,
  normalizeName,
  recordPath,
  renameRecord,
  uniqueName,
} from '../src/index.js';

describe('ids', () => {
  it('creates document and library ids with the expected shape', () => {
    const documentId = createDocumentId();
    const libraryId = createLibraryId();

    assert.match(documentId, /^doc_[0-9a-z]{10}$/);
    assert.match(libraryId, /^lib_[0-9a-z]{10}$/);
    assert.ok(isDocumentId(documentId));
    assert.ok(isLibraryId(libraryId));
  });

  it('does not repeat ids', () => {
    const ids = new Set();
    for (let index = 0; index < 2_000; index += 1) ids.add(createDocumentId());
    assert.equal(ids.size, 2_000);
  });

  it('rejects ids from another prefix or shape', () => {
    assert.equal(isDocumentId('lib_abcdefghij'), false);
    assert.equal(isDocumentId('doc_'), false);
    assert.equal(isDocumentId('doc_ABCDEFGHIJ'), false);
    assert.equal(isDocumentId(42), false);
  });
});

describe('normalizeName', () => {
  it('trims and collapses whitespace', () => {
    assert.equal(normalizeName('  my   report.pdf  '), 'my report.pdf');
  });

  it('replaces path separators and reserved characters', () => {
    assert.equal(normalizeName('a/b\\c.txt'), 'a-b-c.txt');
    assert.equal(normalizeName('what?.pdf'), 'what-.pdf');
    assert.equal(normalizeName('a:b*c"d<e>f|g.txt'), 'a-b-c-d-e-f-g.txt');
  });

  it('drops control characters', () => {
    assert.equal(normalizeName('a\u0001b\u001fc.txt'), 'a-b-c.txt');
  });

  it('strips leading dots and trailing dots or spaces', () => {
    assert.equal(normalizeName('..hidden'), 'hidden');
    assert.equal(normalizeName('report.pdf...'), 'report.pdf');
    assert.equal(normalizeName('report.pdf   '), 'report.pdf');
  });

  it('falls back to untitled', () => {
    assert.equal(normalizeName(''), 'untitled');
    assert.equal(normalizeName('   '), 'untitled');
    assert.equal(normalizeName('...'), 'untitled');
    assert.equal(normalizeName(undefined), 'untitled');
    assert.equal(normalizeName(42), 'untitled');
  });

  it('caps the length', () => {
    const name = normalizeName(`${'a'.repeat(300)}.pdf`);
    assert.ok(name.length <= MAX_NAME_LENGTH);
  });
});

describe('guessMediaType', () => {
  it('maps common extensions case-insensitively', () => {
    assert.equal(guessMediaType('Report.PDF'), 'application/pdf');
    assert.equal(guessMediaType('notes.md'), 'text/markdown');
    assert.equal(guessMediaType('data.json'), 'application/json');
    assert.equal(guessMediaType('photo.jpeg'), 'image/jpeg');
  });

  it('falls back to a binary type', () => {
    assert.equal(guessMediaType('archive.unknown'), 'application/octet-stream');
    assert.equal(guessMediaType('no-extension'), 'application/octet-stream');
  });
});

describe('uniqueName', () => {
  it('keeps a free name unchanged', () => {
    assert.equal(uniqueName([], 'report.pdf'), 'report.pdf');
    assert.equal(uniqueName(['other.pdf'], 'report.pdf'), 'report.pdf');
  });

  it('adds a numeric suffix before the extension', () => {
    assert.equal(uniqueName(['report.pdf'], 'report.pdf'), 'report (2).pdf');
    assert.equal(
      uniqueName(['report.pdf', 'report (2).pdf'], 'report.pdf'),
      'report (3).pdf',
    );
  });

  it('compares case-insensitively', () => {
    assert.equal(uniqueName(['REPORT.PDF'], 'report.pdf'), 'report (2).pdf');
  });

  it('handles names without an extension', () => {
    assert.equal(uniqueName(['notes'], 'notes'), 'notes (2)');
  });

  it('normalizes the incoming name', () => {
    assert.equal(uniqueName([], '  a/b.txt '), 'a-b.txt');
  });
});

describe('records', () => {
  it('builds a record with an inferred type and path', () => {
    const record = createRecord({ name: 'Report.PDF', size: 2_048 });

    assert.ok(isDocumentId(record.id));
    assert.equal(record.name, 'Report.PDF');
    assert.equal(record.mediaType, 'application/pdf');
    assert.equal(record.size, 2_048);
    assert.equal(record.path, `documents/${record.id}/Report.PDF`);
    assert.equal(record.createdAt, record.updatedAt);
  });

  it('uses an explicit media type when given', () => {
    const record = createRecord({ name: 'notes', mediaType: 'text/plain' });
    assert.equal(record.mediaType, 'text/plain');
  });

  it('defaults a missing size to zero', () => {
    assert.equal(createRecord({ name: 'a.txt' }).size, 0);
  });

  it('validates its own output', () => {
    const record = createRecord({ name: 'a.txt', size: 1 });
    assert.doesNotThrow(() => assertValidRecord(record));
  });

  it('rejects malformed records', () => {
    const record = createRecord({ name: 'a.txt', size: 1 });

    assert.throws(() => assertValidRecord(null), /must be an object/);
    assert.throws(() => assertValidRecord({ ...record, id: 'nope' }), /Invalid document id/);
    assert.throws(
      () => assertValidRecord({ ...record, name: 'a/b.txt' }),
      /Invalid document name/,
    );
    assert.throws(
      () => assertValidRecord({ ...record, mediaType: '' }),
      /Invalid media type/,
    );
    assert.throws(() => assertValidRecord({ ...record, size: -1 }), /Invalid size/);
    assert.throws(
      () => assertValidRecord({ ...record, path: 'elsewhere/a.txt' }),
      /Invalid path/,
    );
    assert.throws(
      () => assertValidRecord({ ...record, createdAt: 'yesterday' }),
      /Invalid createdAt/,
    );
  });

  it('renames while keeping the id and updating the path', () => {
    const record = createRecord({ name: 'a.txt', size: 1 });
    const renamed = renameRecord(record, 'b.txt', { now: '2026-01-01T00:00:00.000Z' });

    assert.equal(renamed.id, record.id);
    assert.equal(renamed.name, 'b.txt');
    assert.equal(renamed.path, recordPath(record.id, 'b.txt'));
    assert.equal(renamed.createdAt, record.createdAt);
    assert.equal(renamed.updatedAt, '2026-01-01T00:00:00.000Z');
  });
});
