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
import { base64ToBytes, bytesToBase64 } from './native/base64.js';
import { createNativeClient } from './native/native-client.js';
import { createNativeLibrary } from './native/native-library.js';

export * from './panel-position.js';

export { createRecordStorage };
export { openIdbRecordStorage };
export { base64ToBytes, bytesToBase64 };
export { createNativeClient };
export { createNativeLibrary };
export {
  NATIVE_MAX_IMPORT_BYTES,
  NATIVE_READ_CHUNK_BYTES,
} from './native/native-library.js';

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
