// Base64 helpers shared by the native library adapter.
//
// `btoa`/`atob` take binary strings, so bytes are converted in small slices to
// avoid blowing the call stack on large documents.

const CHUNK = 0x8000;

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let binary = '';

  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }

  return btoa(binary);
}

/** @param {string} text */
export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
