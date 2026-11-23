// IndexedDB backend for record storage.
//
// Two object stores: `records` (keyPath `id`) and `blobs` (keyed by id). The
// bytes are kept out of the record store so listing the library never
// deserializes file contents.
//
// Version 2 adds those stores and migrates the legacy `files` store, which was
// name-keyed. The migration runs once and is guarded by a flag in `meta`; it
// only deletes legacy keys whose values were actually migrated.

import { planLegacyMigration } from '../library/migration.js';

const DB_VERSION = 2;
const RECORDS = 'records';
const BLOBS = 'blobs';
const META = 'meta';
const LEGACY_STORE = 'files';
const MIGRATION_KEY = 'legacyFilesMigrated';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    let request;

    try {
      request = indexedDB.open(name, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(RECORDS)) {
        db.createObjectStore(RECORDS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS);
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // Close this connection if another context wants to upgrade the schema.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () =>
      reject(request.error || new Error(`Could not open the "${name}" database.`));
    request.onblocked = () =>
      reject(new Error(`The "${name}" database is blocked by another open tab.`));
  });
}

/**
 * Copy the legacy name-keyed store into records, once.
 *
 * Runs after the database is open, in a normal transaction, so the upgrade
 * handler stays synchronous and simple.
 */
async function migrateLegacyStore(db) {
  if (!db.objectStoreNames.contains(LEGACY_STORE)) return;

  const transaction = db.transaction([RECORDS, BLOBS, META, LEGACY_STORE], 'readwrite');
  const done = transactionToPromise(transaction);
  // Avoid an unhandled rejection if a request below throws first.
  done.catch(() => {});

  const meta = transaction.objectStore(META);

  const alreadyMigrated = await requestToPromise(meta.get(MIGRATION_KEY));

  if (!alreadyMigrated) {
    const legacy = transaction.objectStore(LEGACY_STORE);
    const [keys, values] = await Promise.all([
      requestToPromise(legacy.getAllKeys()),
      requestToPromise(legacy.getAll()),
    ]);

    const entries = [];
    for (let index = 0; index < keys.length; index += 1) {
      if (values[index] instanceof Blob) {
        entries.push({ key: keys[index], name: String(keys[index]), blob: values[index] });
      }
    }

    const plan = planLegacyMigration(entries);
    const records = transaction.objectStore(RECORDS);
    const blobs = transaction.objectStore(BLOBS);

    for (const { record, blob } of plan) {
      records.put(record);
      blobs.put(blob, record.id);
    }

    // Only drop the legacy keys we actually migrated.
    for (const entry of entries) {
      legacy.delete(entry.key);
    }

    meta.put({ count: plan.length, at: new Date().toISOString() }, MIGRATION_KEY);
  }

  await done;
}

/**
 * Open an IndexedDB-backed record store.
 *
 * @param {{ name?: string }} [options]
 * @returns {Promise<{
 *   put: (record: object, blob: Blob) => Promise<void>,
 *   get: (id: string) => Promise<{ record: object, blob: Blob } | undefined>,
 *   list: () => Promise<object[]>,
 *   remove: (id: string) => Promise<void>,
 *   clear: () => Promise<void>,
 *   close: () => void,
 * }>}
 */
export async function openIdbRecordStorage({ name = 'nooksuite-library' } = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('A non-empty database name is required.');
  }

  const db = await openDatabase(name);
  await migrateLegacyStore(db);

  return {
    async put(record, blob) {
      const transaction = db.transaction([RECORDS, BLOBS], 'readwrite');
      transaction.objectStore(RECORDS).put(record);
      transaction.objectStore(BLOBS).put(blob, record.id);
      await transactionToPromise(transaction);
    },

    async get(id) {
      const transaction = db.transaction([RECORDS, BLOBS], 'readonly');
      const done = transactionToPromise(transaction);

      const recordRequest = transaction.objectStore(RECORDS).get(id);
      const blobRequest = transaction.objectStore(BLOBS).get(id);

      const [record, blob] = await Promise.all([
        requestToPromise(recordRequest),
        requestToPromise(blobRequest),
      ]);

      await done;
      return record ? { record, blob } : undefined;
    },

    async list() {
      const transaction = db.transaction(RECORDS, 'readonly');
      const done = transactionToPromise(transaction);

      const records = await requestToPromise(transaction.objectStore(RECORDS).getAll());

      await done;
      return records;
    },

    async remove(id) {
      const transaction = db.transaction([RECORDS, BLOBS], 'readwrite');
      transaction.objectStore(RECORDS).delete(id);
      transaction.objectStore(BLOBS).delete(id);
      await transactionToPromise(transaction);
    },

    async clear() {
      const transaction = db.transaction([RECORDS, BLOBS], 'readwrite');
      transaction.objectStore(RECORDS).clear();
      transaction.objectStore(BLOBS).clear();
      await transactionToPromise(transaction);
    },

    close() {
      db.close();
    },
  };
}
