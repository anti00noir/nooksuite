// Document records: the unit of the shared library.
//
// A record is metadata; the bytes live beside it in
// `documents/<id>/<name>`. Both NookBin (IndexedDB today) and NookEdit (the
// on-disk library) use this shape, so a document can move between them without
// being reinterpreted.

import { createDocumentId, isDocumentId } from './ids.js';

export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
export const MAX_NAME_LENGTH = 120;

// Characters Windows rejects in file names, plus control characters.
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

const MEDIA_TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/**
 * Turn any user- or filesystem-supplied name into a safe file name.
 *
 * Path separators and reserved characters become `-`, control characters are
 * dropped, leading dots are stripped (no hidden files, no `.`/`..`), and
 * trailing dots and spaces are trimmed because Windows rejects them.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeName(name) {
  let value = typeof name === 'string' ? name : '';
  value = value.replace(ILLEGAL_NAME_CHARS, '-').replace(/\u0000/g, '');
  value = value.replace(/\s+/g, ' ').trim();
  value = value.replace(/^\.+/, '').replace(/[. ]+$/, '');
  value = value.slice(0, MAX_NAME_LENGTH).replace(/[. ]+$/, '');

  return value.length > 0 ? value : 'untitled';
}

/** Split `report.tar.gz` into `['report.tar', '.gz']`; no extension gives `['name', '']`. */
function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/** Infer a media type from a file name. */
export function guessMediaType(name) {
  const [, extension] = splitExtension(normalizeName(name));
  const key = extension.slice(1).toLowerCase();
  return MEDIA_TYPES[key] ?? DEFAULT_MEDIA_TYPE;
}

/**
 * Pick a name that does not collide with the existing ones.
 *
 * Comparison is case-insensitive because the default library lives on a
 * case-insensitive filesystem. Collisions become `report (2).pdf`.
 *
 * @param {Iterable<string>} existingNames
 * @param {string} name
 * @returns {string}
 */
export function uniqueName(existingNames, name) {
  const taken = new Set(
    [...existingNames].map((existing) => normalizeName(existing).toLowerCase()),
  );

  const candidate = normalizeName(name);
  if (!taken.has(candidate.toLowerCase())) return candidate;

  const [base, extension] = splitExtension(candidate);

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const next = `${base} (${suffix})${extension}`;
    if (!taken.has(next.toLowerCase())) return next;
  }

  throw new Error(`Could not find a free name for "${candidate}".`);
}

/** Relative path of a record's bytes inside the library. */
export function recordPath(id, name) {
  return `documents/${id}/${name}`;
}

/**
 * Build a record. Callers normally get one from a storage backend rather than
 * constructing it directly.
 *
 * @param {{
 *   id?: string,
 *   name: string,
 *   mediaType?: string,
 *   size?: number,
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} input
 */
export function createRecord(input) {
  const id = input.id ?? createDocumentId();
  const name = normalizeName(input.name);
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    id,
    name,
    mediaType: input.mediaType || guessMediaType(name),
    size: Number.isFinite(input.size) && input.size >= 0 ? input.size : 0,
    path: recordPath(id, name),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };
}

/**
 * Validate a record read from storage or from `library.json`.
 *
 * @param {unknown} record
 * @returns {void}
 */
export function assertValidRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('A document record must be an object.');
  }

  if (!isDocumentId(record.id)) {
    throw new TypeError(`Invalid document id: ${JSON.stringify(record.id)}.`);
  }

  if (typeof record.name !== 'string' || normalizeName(record.name) !== record.name) {
    throw new TypeError(`Invalid document name for ${record.id}: ${JSON.stringify(record.name)}.`);
  }

  if (typeof record.mediaType !== 'string' || record.mediaType.length === 0) {
    throw new TypeError(`Invalid media type for ${record.id}.`);
  }

  if (!Number.isFinite(record.size) || record.size < 0) {
    throw new TypeError(`Invalid size for ${record.id}.`);
  }

  if (record.path !== recordPath(record.id, record.name)) {
    throw new TypeError(`Invalid path for ${record.id}: ${JSON.stringify(record.path)}.`);
  }

  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof record[field] !== 'string' || Number.isNaN(Date.parse(record[field]))) {
      throw new TypeError(`Invalid ${field} for ${record.id}.`);
    }
  }
}

/** Rename a record, keeping its id and timestamps consistent. */
export function renameRecord(record, name, { now = new Date().toISOString() } = {}) {
  assertValidRecord(record);
  const nextName = normalizeName(name);

  return {
    ...record,
    name: nextName,
    path: recordPath(record.id, nextName),
    updatedAt: now,
  };
}
