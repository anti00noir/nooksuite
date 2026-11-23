import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getRecordStorage, openIdbRecordStorage } from '../src/index.js';

const TEST_DB_PREFIX = 'nooksuite-record-test';

let dbNames;
let openStores;

beforeEach(() => {
  dbNames = new Set();
  openStores = [];
});

afterEach(async () => {
  for (const store of openStores) store.close();
  openStores = [];

  for (const name of dbNames) await deleteDatabase(name);

  dbNames.clear();
});

function newDbName() {
  const name = `${TEST_DB_PREFIX}-${crypto.randomUUID()}`;
  dbNames.add(name);
  return name;
}

async function openStore(name = newDbName()) {
  const store = await getRecordStorage({ name });
  openStores.push(store);
  return store;
}

function makeFile(name, contents, type = 'text/plain') {
  return new File([contents], name, { type, lastModified: 1_700_000_000_000 });
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Create a version-1 database shaped like the pre-Phase-1 extension store. */
function seedLegacyDatabase(name, entries) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);

    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('files');
      for (const [key, value] of entries) store.put(value, key);
    };

    request.onsuccess = () => {
      request.result.close();
      resolve();
    };

    request.onerror = () => reject(request.error);
  });
}

/** Read a store from the database without going through the record backend. */
function readRawStore(name, storeName, reader) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);

    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(storeName, 'readonly');
      const result = reader(transaction.objectStore(storeName));

      result.onsuccess = () => {
        db.close();
        resolve(result.result);
      };
      result.onerror = () => {
        db.close();
        reject(result.error);
      };
    };

    request.onerror = () => reject(request.error);
  });
}

describe('getRecordStorage', () => {
  it('rejects an empty database name', async () => {
    await assert.rejects(() => getRecordStorage({ name: '' }), /non-empty database name/);
  });

  it('starts empty', async () => {
    const store = await openStore();

    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('doc_missing000'), undefined);
    assert.equal(await store.getRecord('doc_missing000'), undefined);
  });

  it('stores a file and returns its record', async () => {
    const store = await openStore();
    const record = await store.put(makeFile('report.pdf', 'PDF', 'application/pdf'));

    assert.match(record.id, /^doc_[0-9a-z]{10}$/);
    assert.equal(record.name, 'report.pdf');
    assert.equal(record.mediaType, 'application/pdf');
    assert.equal(record.size, 3);
    assert.equal(record.path, `documents/${record.id}/report.pdf`);

    const blob = await store.get(record.id);
    assert.equal(await blob.text(), 'PDF');

    const stored = await store.getRecord(record.id);
    assert.deepEqual(stored, record);
  });

  it('keeps duplicate names side by side', async () => {
    const store = await openStore();

    const first = await store.put(makeFile('notes.txt', 'one'));
    const second = await store.put(makeFile('notes.txt', 'two'));

    assert.notEqual(first.id, second.id);
    assert.equal(first.name, 'notes.txt');
    assert.equal(second.name, 'notes (2).txt');
    assert.equal(await (await store.get(second.id)).text(), 'two');
  });

  it('lists records sorted by name', async () => {
    const store = await openStore();
    await store.put(makeFile('b.txt', 'b'));
    await store.put(makeFile('A.txt', 'a'));

    assert.deepEqual(
      (await store.list()).map((record) => record.name),
      ['A.txt', 'b.txt'],
    );
  });

  it('accepts a Blob without a name', async () => {
    const store = await openStore();
    const record = await store.put(new Blob(['raw'], { type: 'text/plain' }));

    assert.equal(record.name, 'untitled');
  });

  it('rejects values that are not Blobs', async () => {
    const store = await openStore();
    await assert.rejects(() => store.put('not a blob'), /Only Blob or File/);
  });

  it('removes a record and its bytes', async () => {
    const store = await openStore();
    const keep = await store.put(makeFile('keep.txt', 'keep'));
    const drop = await store.put(makeFile('drop.txt', 'drop'));

    await store.remove(drop.id);

    assert.deepEqual(
      (await store.list()).map((record) => record.id),
      [keep.id],
    );
    assert.equal(await store.get(drop.id), undefined);
  });

  it('renames a record, keeping its id and bytes', async () => {
    const store = await openStore();
    const record = await store.put(makeFile('old.txt', 'body'));

    const renamed = await store.rename(record.id, 'new.txt');

    assert.equal(renamed.id, record.id);
    assert.equal(renamed.name, 'new.txt');
    assert.equal(renamed.path, `documents/${record.id}/new.txt`);
    assert.equal(await (await store.get(record.id)).text(), 'body');
  });

  it('makes a renamed record unique', async () => {
    const store = await openStore();
    await store.put(makeFile('taken.txt', 'a'));
    const record = await store.put(makeFile('mine.txt', 'b'));

    const renamed = await store.rename(record.id, 'taken.txt');
    assert.equal(renamed.name, 'taken (2).txt');
  });

  it('rejects renaming an unknown id', async () => {
    const store = await openStore();
    await assert.rejects(() => store.rename('doc_missing000', 'x.txt'), /No document with id/);
  });

  it('clears every record', async () => {
    const store = await openStore();
    await store.put(makeFile('a.txt', 'a'));
    await store.put(makeFile('b.txt', 'b'));

    await store.clear();

    assert.deepEqual(await store.list(), []);
  });

  it('keeps records after the connection is reopened', async () => {
    const name = newDbName();
    const first = await getRecordStorage({ name });
    const record = await first.put(makeFile('a.txt', 'a'));
    first.close();

    const second = await getRecordStorage({ name });
    openStores.push(second);

    const records = await second.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, record.id);
    assert.equal(await (await second.get(record.id)).text(), 'a');
  });
});

describe('legacy migration', () => {
  it('converts name-keyed files into records', async () => {
    const name = newDbName();
    await seedLegacyDatabase(name, [
      ['b.txt', new Blob(['B'], { type: 'text/plain' })],
      ['a.txt', new Blob(['A'], { type: 'text/plain' })],
    ]);

    const store = await getRecordStorage({ name });
    openStores.push(store);

    const records = await store.list();
    assert.deepEqual(
      records.map((record) => record.name),
      ['a.txt', 'b.txt'],
    );
    assert.equal(await (await store.get(records[0].id)).text(), 'A');
    assert.equal(records[0].size, 1);
    assert.equal(records[0].mediaType, 'text/plain');
  });

  it('empties the legacy keys it migrated', async () => {
    const name = newDbName();
    await seedLegacyDatabase(name, [['a.txt', new Blob(['A'])]]);

    const store = await openIdbRecordStorage({ name });
    openStores.push(store);
    await store.list();

    assert.equal(await readRawStore(name, 'files', (legacy) => legacy.count()), 0);
  });

  it('leaves values it cannot migrate in place', async () => {
    const name = newDbName();
    await seedLegacyDatabase(name, [
      ['a.txt', new Blob(['A'])],
      ['not-a-blob', 'plain string'],
    ]);

    const store = await openIdbRecordStorage({ name });
    openStores.push(store);

    assert.equal((await store.list()).length, 1);
    assert.equal(await readRawStore(name, 'files', (legacy) => legacy.count()), 1);
  });

  it('does not migrate twice', async () => {
    const name = newDbName();
    await seedLegacyDatabase(name, [['a.txt', new Blob(['A'])]]);

    const first = await openIdbRecordStorage({ name });
    assert.equal((await first.list()).length, 1);
    first.close();

    const second = await openIdbRecordStorage({ name });
    openStores.push(second);

    assert.equal((await second.list()).length, 1);
  });

  it('starts clean when there is no legacy store', async () => {
    const store = await openStore();
    assert.deepEqual(await store.list(), []);
  });
});
