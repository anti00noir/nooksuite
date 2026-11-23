// Stable, opaque identifiers for library records.
//
// IDs appear in on-disk folder names (`documents/<id>/`) and in library.json,
// so they must be filesystem-safe, short, and collision-resistant enough for a
// personal library. They are not sequential: two devices importing the same
// document must never generate the same id for different files.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 10;

function randomSuffix(length = ID_LENGTH) {
  const bytes = new Uint8Array(length);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let suffix = '';
  for (let index = 0; index < length; index += 1) {
    suffix += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return suffix;
}

/** Create an id for a document record, e.g. `doc_9f2k1m4x7q`. */
export function createDocumentId() {
  return `doc_${randomSuffix()}`;
}

/** Create an id for a library, e.g. `lib_9f2k1m4x7q`. */
export function createLibraryId() {
  return `lib_${randomSuffix()}`;
}

/** True for ids this module would generate. */
export function isDocumentId(value) {
  return typeof value === 'string' && /^doc_[0-9a-z]{6,32}$/.test(value);
}

/** True for library ids this module would generate. */
export function isLibraryId(value) {
  return typeof value === 'string' && /^lib_[0-9a-z]{6,32}$/.test(value);
}
