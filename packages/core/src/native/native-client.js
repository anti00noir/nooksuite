// Correlation layer for the NookSuite native messaging port.
//
// The background service worker owns the real `chrome.runtime.Port`; this
// module only relies on the Port shape (postMessage, onMessage, onDisconnect)
// so it can be unit-tested with a fake.
//
// The host answers one request at a time, but several callers can be in flight
// (a list plus a read, two panels, and so on). Each request gets a numeric
// `requestId` and its response is matched back to the waiting promise.

/**
 * @param {{
 *   postMessage: (message: object) => void,
 *   disconnect: () => void,
 *   onMessage: { addListener: (listener: (message: any) => void) => void },
 *   onDisconnect: { addListener: (listener: () => void) => void },
 * }} port
 * @param {{
 *   timeoutMs?: number,
 *   describeDisconnect?: () => string | undefined,
 * }} [options]
 */
export function createNativeClient(port, options = {}) {
  if (
    !port
    || typeof port.postMessage !== 'function'
    || typeof port.disconnect !== 'function'
    || typeof port.onMessage?.addListener !== 'function'
    || typeof port.onDisconnect?.addListener !== 'function'
  ) {
    throw new TypeError('A native messaging port is required.');
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const describeDisconnect = options.describeDisconnect ?? (() => undefined);

  let nextId = 0;
  let closed = false;
  const pending = new Map();

  function rejectAll(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;

    const entry = pending.get(message.requestId);
    if (!entry) return;

    pending.delete(message.requestId);
    clearTimeout(entry.timer);

    if (message.ok) {
      entry.resolve(message);
      return;
    }

    const error = new Error(message.error?.message || 'The NookSuite host reported an error.');
    error.code = message.error?.code;
    entry.reject(error);
  });

  port.onDisconnect.addListener(() => {
    closed = true;
    // `describeDisconnect` runs inside the listener because Chrome only exposes
    // `runtime.lastError` synchronously while the disconnect callback runs.
    const reason = describeDisconnect() || 'The NookSuite host disconnected.';
    rejectAll(new Error(reason));
  });

  return {
    get closed() {
      return closed;
    },

    /** @param {object} payload */
    request(payload) {
      if (closed) {
        return Promise.reject(new Error('The NookSuite host is not connected.'));
      }

      const requestId = ++nextId;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`The NookSuite host did not answer "${payload.op}" in time.`));
        }, timeoutMs);

        pending.set(requestId, { resolve, reject, timer });

        try {
          port.postMessage({ ...payload, requestId });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },

    close() {
      if (closed) return;
      closed = true;

      try {
        port.disconnect();
      } catch {
        // Already gone; the pending promises still need to settle.
      }

      rejectAll(new Error('The NookSuite host connection was closed.'));
    },
  };
}
