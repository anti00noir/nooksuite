// @nooksuite/core — target-agnostic logic shared across the suite's tools.

export {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  VIEWPORT_MARGIN,
  EDGE_MARGIN,
  clamp,
  getPanelSize,
  getDefaultPosition,
  clampPosition,
} from './panel-position.js';

import { createRecordStorage } from './record-storage.js';
import { openIdbRecordStorage } from './backends/idb-record-storage.js';

export * from './panel-position.js';

export { createRecordStorage };
export { openIdbRecordStorage };

export * from './library/ids.js';
export * from './library/record.js';
export * from './library/library-file.js';
export * from './library/migration.js';

/**
 * Open a record store backed by IndexedDB. Records have stable ids, so
 * duplicate names are kept side by side.
 *
 * @param {{ name?: string }} [options]
 */
export async function getRecordStorage(options) {
  return createRecordStorage(await openIdbRecordStorage(options));
}
