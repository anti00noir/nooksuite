// The on-disk library index: `<library>/.nooksuite/library.json`.
//
// One file holds every record, so a reader needs a single request to list the
// library. Bytes stay next to the index in `documents/<id>/`. The index is
// written with a temp-then-rename in the native app, so a reader never sees a
// partial file.

import { createLibraryId, isLibraryId } from './ids.js';
import { assertValidRecord } from './record.js';

export const SCHEMA_VERSION = 1;
export const LIBRARY_DIR = '.nooksuite';
export const LIBRARY_FILE = 'library.json';
export const DOCUMENTS_DIR = 'documents';

/**
 * Create an empty library index.
 *
 * @param {{ libraryId?: string, now?: string }} [options]
 */
export function createLibraryFile({ libraryId, now = new Date().toISOString() } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    libraryId: libraryId ?? createLibraryId(),
    createdAt: now,
    updatedAt: now,
    records: {},
  };
}

/**
 * Parse and validate a library index.
 *
 * Accepts a JSON string or an already-parsed object. Unknown top-level fields
 * are dropped so callers get a predictable shape; records are validated
 * individually.
 *
 * @param {string | object} input
 */
export function parseLibraryFile(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('library.json must contain a JSON object.');
  }

  if (!Number.isInteger(data.schemaVersion)) {
    throw new TypeError('library.json is missing an integer schemaVersion.');
  }

  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `library.json uses schema version ${data.schemaVersion}, but this build supports up to ${SCHEMA_VERSION}.`,
    );
  }

  if (data.schemaVersion < 1) {
    throw new Error(`Unsupported library schema version: ${data.schemaVersion}.`);
  }

  if (!isLibraryId(data.libraryId)) {
    throw new TypeError(`Invalid library id: ${JSON.stringify(data.libraryId)}.`);
  }

  const records = data.records ?? {};
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    throw new TypeError('library.json records must be an object keyed by id.');
  }

  const normalized = {};

  for (const [id, record] of Object.entries(records)) {
    assertValidRecord(record);
    if (record.id !== id) {
      throw new TypeError(`Record "${id}" has a mismatched id "${record.id}".`);
    }
    normalized[id] = record;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    libraryId: data.libraryId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    records: normalized,
  };
}

/** Serialize a library index to the exact text written to disk. */
export function serializeLibraryFile(library) {
  return `${JSON.stringify(library, null, 2)}\n`;
}

/**
 * Add or replace a record. Returns a new library object.
 *
 * @param {object} library
 * @param {object} record
 */
export function upsertRecord(library, record) {
  assertValidRecord(record);

  return {
    ...library,
    records: { ...library.records, [record.id]: record },
    updatedAt: record.updatedAt,
  };
}

/**
 * Remove a record by id. Returns a new library object; unknown ids are a no-op.
 *
 * @param {object} library
 * @param {string} id
 * @param {{ now?: string }} [options]
 */
export function removeRecord(library, id, { now = new Date().toISOString() } = {}) {
  if (!Object.hasOwn(library.records, id)) return library;

  const records = { ...library.records };
  delete records[id];

  return { ...library, records, updatedAt: now };
}

/**
 * Records sorted for display: case-insensitive by name, id as the tie-break so
 * the order is stable.
 */
export function listRecords(library) {
  return Object.values(library.records).sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id),
  );
}
