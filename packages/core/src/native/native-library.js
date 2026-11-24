// Record store backed by the NookSuite native host.
//
// The host owns the on-disk library, so every rule (ids, unique names,
// timestamps, media types) is applied in Rust. This adapter only translates
// between Blobs and the JSON protocol, and reassembles chunked reads.
//
// It exposes the same surface the panel uses from `createRecordStorage`, so the
// panel can swap backends without knowing which one it got.

import { base64ToBytes, bytesToBase64 } from './base64.js';

// Chrome caps messages from the host at 1 MB; the host never sends more than
// 512 KB of raw bytes per read.
export const NATIVE_READ_CHUNK_BYTES = 512 * 1024;
// 32 MB raw is about 43 MB of base64, comfortably under the host's 64 MB
// per-message limit and the panel's own inject cap.
export const NATIVE_MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/**
 * @param {(payload: object) => Promise<any>} request Sends one protocol request
 *   and resolves with its successful response.
 */
export function createNativeLibrary(request) {
  if (typeof request !== 'function') {
    throw new TypeError('A native request function is required.');
  }

  const records = new Map();

  function remember(record) {
    if (record?.id) records.set(record.id, record);
    return record;
  }

  async function listRecords() {
    const response = await request({ op: 'list' });

    records.clear();
    for (const record of response.records) records.set(record.id, record);

    return [...response.records].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        || a.id.localeCompare(b.id),
    );
  }

  async function getRecord(id) {
    if (records.has(id)) return records.get(id);
    await listRecords();
    return records.get(id) ?? null;
  }

  return {
    async ping() {
      return request({ op: 'ping' });
    },

    /**
     * Store a Blob or File. The host picks the id, timestamps, and a unique
     * name, and returns the finished record.
     *
     * @param {Blob} value
     * @param {{ name?: string, mediaType?: string }} [putOptions]
     */
    async put(value, putOptions = {}) {
      if (!(value instanceof Blob)) {
        throw new TypeError('Only Blob or File values can be stored.');
      }

      if (value.size > NATIVE_MAX_IMPORT_BYTES) {
        throw new Error(
          `The disk library takes files up to ${NATIVE_MAX_IMPORT_BYTES / (1024 * 1024)} MB.`,
        );
      }

      const name = putOptions.name
        ?? (typeof value.name === 'string' ? value.name : 'untitled');
      const data = bytesToBase64(new Uint8Array(await value.arrayBuffer()));

      const response = await request({
        op: 'import',
        name,
        mediaType: putOptions.mediaType || value.type || undefined,
        data,
      });

      return remember(response.record);
    },

    /** @param {string} id */
    async get(id) {
      const record = await getRecord(id);
      const chunks = [];
      let offset = 0;

      for (;;) {
        const response = await request({
          op: 'read',
          id,
          offset,
          length: NATIVE_READ_CHUNK_BYTES,
        });

        chunks.push(base64ToBytes(response.data));
        remember(response.record);

        if (response.eof) break;

        if (!(response.nextOffset > offset)) {
          throw new Error('The host did not advance the read offset.');
        }

        offset = response.nextOffset;
      }

      return new Blob(chunks, { type: record?.mediaType ?? '' });
    },

    /** @param {string} id */
    async getRecord(id) {
      return getRecord(id);
    },

    async list() {
      return listRecords();
    },

    /** @param {string} id @param {string} name */
    async rename(id, name) {
      const response = await request({ op: 'rename', id, name });
      return remember(response.record);
    },

    /** @param {string} id */
    async remove(id) {
      await request({ op: 'remove', id });
      records.delete(id);
    },

    async clear() {
      const response = await request({ op: 'list' });

      for (const record of response.records) {
        await request({ op: 'remove', id: record.id });
      }

      records.clear();
    },

    close() {
      // The background service worker owns the connection; the panel closing
      // must not tear down the shared port.
    },
  };
}
