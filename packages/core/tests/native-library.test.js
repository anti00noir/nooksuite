import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createNativeLibrary } from '../src/index.js';

function decodeBase64(text) {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function hostError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * A small in-memory stand-in for the Rust host. `chunkBytes` forces more read
 * round trips than the real host would need, so reassembly is exercised.
 */
function createFakeHost({ chunkBytes = 4 } = {}) {
  const records = new Map();
  const blobs = new Map();
  const calls = [];
  let nextId = 0;

  async function request(payload) {
    calls.push(payload);

    switch (payload.op) {
      case 'ping':
        return {
          ok: true,
          protocolVersion: 1,
          hostVersion: 'test',
          library: { root: 'C:\\Library', libraryId: 'lib_test000001', recordCount: records.size },
        };

      case 'list':
        return {
          ok: true,
          root: 'C:\\Library',
          libraryId: 'lib_test000001',
          records: [...records.values()],
        };

      case 'import': {
        const bytes = decodeBase64(payload.data);
        const id = `doc_test${String(++nextId).padStart(6, '0')}`;
        const record = {
          id,
          name: payload.name,
          mediaType: payload.mediaType ?? 'application/octet-stream',
          size: bytes.length,
          path: `documents/${id}/${payload.name}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };

        records.set(id, record);
        blobs.set(id, bytes);
        return { ok: true, record };
      }

      case 'read': {
        const bytes = blobs.get(payload.id);
        if (!bytes) {
          throw hostError('not_found', `No document with id "${payload.id}".`);
        }

        const offset = payload.offset ?? 0;
        const take = Math.min(payload.length ?? chunkBytes, chunkBytes);
        const slice = bytes.subarray(offset, offset + take);

        return {
          ok: true,
          record: records.get(payload.id),
          data: encodeBase64(slice),
          offset,
          nextOffset: offset + slice.length,
          eof: offset + slice.length >= bytes.length,
        };
      }

      case 'rename': {
        const record = records.get(payload.id);
        if (!record) throw hostError('not_found', `No document with id "${payload.id}".`);

        const renamed = {
          ...record,
          name: payload.name,
          path: `documents/${record.id}/${payload.name}`,
          updatedAt: '2026-01-02T00:00:00.000Z',
        };

        records.set(record.id, renamed);
        return { ok: true, record: renamed };
      }

      case 'remove': {
        records.delete(payload.id);
        blobs.delete(payload.id);
        return { ok: true };
      }

      default:
        throw hostError('bad_request', `Unknown op "${payload.op}".`);
    }
  }

  return {
    calls,
    request,
    readCalls: () => calls.filter((call) => call.op === 'read'),
  };
}

describe('createNativeLibrary', () => {
  it('stores a Blob and reassembles chunked reads', async () => {
    const host = createFakeHost({ chunkBytes: 4 });
    const store = createNativeLibrary(host.request);
    const payload = Uint8Array.from({ length: 10 }, (_, index) => index + 1);

    const record = await store.put(new Blob([payload], { type: 'text/plain' }), {
      name: 'notes.txt',
    });

    assert.equal(record.name, 'notes.txt');
    assert.equal(record.mediaType, 'text/plain');
    assert.equal(record.size, payload.length);

    const imported = host.calls.find((call) => call.op === 'import');
    assert.deepEqual(decodeBase64(imported.data), payload);

    const blob = await store.get(record.id);

    assert.equal(blob.type, 'text/plain');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), payload);
    assert.deepEqual(
      host.readCalls().map((call) => call.offset),
      [0, 4, 8],
    );
  });

  it('lists records sorted by name', async () => {
    const host = createFakeHost();
    const store = createNativeLibrary(host.request);

    await store.put(new Blob(['b'], { type: 'text/plain' }), { name: 'beta.txt' });
    await store.put(new Blob(['a'], { type: 'text/plain' }), { name: 'Alpha.txt' });

    const records = await store.list();
    assert.deepEqual(records.map((record) => record.name), ['Alpha.txt', 'beta.txt']);
  });

  it('caches records so getRecord does not list again', async () => {
    const host = createFakeHost();
    const store = createNativeLibrary(host.request);

    const record = await store.put(new Blob(['x']), { name: 'x.txt' });
    const listsBefore = host.calls.filter((call) => call.op === 'list').length;

    assert.equal((await store.getRecord(record.id)).name, 'x.txt');
    assert.equal(
      host.calls.filter((call) => call.op === 'list').length,
      listsBefore,
    );
  });

  it('renames and removes through the host', async () => {
    const host = createFakeHost();
    const store = createNativeLibrary(host.request);

    const record = await store.put(new Blob(['x']), { name: 'x.txt' });
    const renamed = await store.rename(record.id, 'renamed.txt');

    assert.equal(renamed.name, 'renamed.txt');
    assert.equal((await store.getRecord(record.id)).name, 'renamed.txt');

    await store.remove(record.id);
    assert.equal(await store.getRecord(record.id), null);
  });

  it('clears the library by removing each record', async () => {
    const host = createFakeHost();
    const store = createNativeLibrary(host.request);

    await store.put(new Blob(['a']), { name: 'a.txt' });
    await store.put(new Blob(['b']), { name: 'b.txt' });

    await store.clear();

    assert.deepEqual(await store.list(), []);
  });

  it('rejects values that are not Blobs', async () => {
    const store = createNativeLibrary(createFakeHost().request);

    await assert.rejects(store.put('not a blob'), /Blob/);
  });

  it('surfaces host errors', async () => {
    const host = createFakeHost();
    const store = createNativeLibrary(host.request);

    await assert.rejects(store.get('doc_missing000'), (error) => {
      assert.equal(error.code, 'not_found');
      return true;
    });
  });
});
