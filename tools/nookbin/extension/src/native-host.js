// Client side of the native messaging bridge.
//
// The background service worker owns the actual `chrome.runtime.Port` so there
// is exactly one host process (and one writer) per browser profile. The panel
// only sends request payloads and receives responses.

const NATIVE_MESSAGE = 'nookbin:native';

/**
 * Create the `request(payload)` function `createNativeLibrary` expects.
 * Failures arrive as Errors with a `code` when the host supplied one.
 */
export function createNativeTransport() {
  return async function request(payload) {
    let response;

    try {
      response = await chrome.runtime.sendMessage({
        type: NATIVE_MESSAGE,
        payload,
      });
    } catch (error) {
      throw new Error(`Could not reach the NookSuite host: ${error?.message ?? error}`);
    }

    if (!response) {
      throw new Error('The NookSuite host did not respond.');
    }

    if (!response.ok) {
      const error = new Error(response.error || 'The NookSuite host reported an error.');
      error.code = response.code;
      throw error;
    }

    return response.payload;
  };
}

/**
 * Classify why the host is unavailable so the panel can choose between a quiet
 * fallback and a visible warning.
 */
export function classifyNativeFailure(error) {
  const message = error?.message ?? String(error);

  if (/native messaging host not found/i.test(message)) {
    return { kind: 'missing', message };
  }

  if (/forbidden|not allowed|access to the specified/i.test(message)) {
    return { kind: 'forbidden', message };
  }

  return { kind: 'error', message };
}
