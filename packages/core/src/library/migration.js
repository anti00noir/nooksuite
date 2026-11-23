// Migration from the legacy name-keyed store to records.
//
// Before Phase 1 a library was `name -> Blob`, so a second file with the same
// name replaced the first. Records give every document its own id and folder,
// which means duplicates need distinct names. This module plans that rewrite
// without touching storage, so it can be tested on its own and reused by any
// backend.

import { createDocumentId } from './ids.js';
import { createRecord, uniqueName } from './record.js';

/**
 * Turn legacy `{ name, blob }` entries into `{ record, blob }` pairs.
 *
 * Entries without a Blob are skipped. Duplicate names get the usual ` (2)`
 * suffix, in the order they appear.
 *
 * @param {Array<{ name?: string, blob?: Blob }>} entries
 * @param {{ now?: string, idFactory?: () => string }} [options]
 * @returns {Array<{ record: object, blob: Blob }>}
 */
export function planLegacyMigration(entries, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory ?? createDocumentId;

  const plan = [];
  const names = [];

  for (const entry of entries) {
    const blob = entry?.blob;
    if (!(blob instanceof Blob)) continue;

    const requested = entry.name || (typeof blob.name === 'string' ? blob.name : 'untitled');
    const name = uniqueName(names, requested);
    names.push(name);

    const record = createRecord({
      id: idFactory(),
      name,
      mediaType: blob.type || undefined,
      size: blob.size,
      createdAt: now,
      updatedAt: now,
    });

    plan.push({ record, blob });
  }

  return plan;
}
