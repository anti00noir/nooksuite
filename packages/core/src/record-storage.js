// Record storage interface.
//
// A backend persists `(record, blob)` pairs; this wrapper owns the rules every
// target shares: name normalization, unique names, id creation, timestamps, and
// input validation. Backends are storage-only, which keeps them swappable
// between IndexedDB (the extension) and the native library.

import { createDocumentId } from './library/ids.js';
import { createRecord, renameRecord, uniqueName } from './library/record.js';

const BACKEND_METHODS = ['put', 'get', 'list', 'remove', 'clear', 'close'];

/**
 * Wrap a record backend in the shared storage interface.
 *
 * The backend must expose:
 *   put(record, blob) -> Promise<void>
 *   get(id) -> Promise<{ record, blob } | undefined>
 *   list() -> Promise<object[]>
 *   remove(id) -> Promise<void>
 *   clear() -> Promise<void>
 *   close() -> void
 *
 * @param {object} backend
 * @param {{ now?: () => string, idFactory?: () => string }} [options]
 */
export function createRecordStorage(backend, options = {}) {
  if (!backend || typeof backend !== 'object') {
    throw new TypeError('A storage backend is required.');
  }

  for (const method of BACKEND_METHODS) {
    if (typeof backend[method] !== 'function') {
      throw new TypeError(`The storage backend is missing ${method}().`);
    }
  }

  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? createDocumentId;

  async function existingNames(exceptId) {
    const records = await backend.list();
    return records.filter((record) => record.id !== exceptId).map((record) => record.name);
  }

  return {
    /**
     * Store a file or blob and return its record.
     *
     * @param {Blob} value
     * @param {{ name?: string, mediaType?: string }} [putOptions]
     */
    async put(value, putOptions = {}) {
      if (!(value instanceof Blob)) {
        throw new TypeError('Only Blob or File values can be stored.');
      }

      const requested = putOptions.name
        ?? (typeof value.name === 'string' ? value.name : 'untitled');
      const name = uniqueName(await existingNames(), requested);

      const record = createRecord({
        id: idFactory(),
        name,
        mediaType: putOptions.mediaType || value.type || undefined,
        size: value.size,
        createdAt: now(),
        updatedAt: now(),
      });

      await backend.put(record, value);
      return record;
    },

    /** @param {string} id */
    async get(id) {
      const entry = await backend.get(id);
      return entry?.blob;
    },

    /** @param {string} id */
    async getRecord(id) {
      const entry = await backend.get(id);
      return entry?.record;
    },

    async list() {
      const records = await backend.list();
      return records.sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
          || a.id.localeCompare(b.id),
      );
    },

    /** @param {string} id */
    async remove(id) {
      await backend.remove(id);
    },

    /**
     * Rename a record, keeping its id and bytes. The new name is made unique.
     *
     * @param {string} id
     * @param {string} name
     */
    async rename(id, name) {
      const entry = await backend.get(id);
      if (!entry) throw new Error(`No document with id "${id}".`);
      if (!(entry.blob instanceof Blob)) {
        throw new Error(`Document "${id}" has no stored bytes.`);
      }

      const unique = uniqueName(await existingNames(id), name);
      const record = renameRecord(entry.record, unique, { now: now() });

      await backend.put(record, entry.blob);
      return record;
    },

    async clear() {
      await backend.clear();
    },

    close() {
      backend.close();
    },
  };
}
