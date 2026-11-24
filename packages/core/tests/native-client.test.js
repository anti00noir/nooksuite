import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createNativeClient } from '../src/index.js';

/** A stand-in for `chrome.runtime.Port`. */
function createFakePort() {
  const messageListeners = [];
  const disconnectListeners = [];

  return {
    sent: [],
    disconnected: false,
    postMessage(message) {
      this.sent.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
    emit(message) {
      for (const listener of messageListeners) listener(message);
    },
    emitDisconnect() {
      for (const listener of disconnectListeners) listener();
    },
  };
}

describe('createNativeClient', () => {
  it('matches a response to its request', async () => {
    const port = createFakePort();
    const client = createNativeClient(port);

    const promise = client.request({ op: 'ping' });

    assert.equal(port.sent.length, 1);
    assert.equal(port.sent[0].op, 'ping');
    assert.equal(port.sent[0].requestId, 1);

    port.emit({ requestId: 1, ok: true, hostVersion: '0.1.0' });

    assert.equal((await promise).hostVersion, '0.1.0');
  });

  it('ignores responses with an unknown requestId', async () => {
    const port = createFakePort();
    const client = createNativeClient(port);
    const promise = client.request({ op: 'list' });

    port.emit({ requestId: 99, ok: true });
    port.emit({ requestId: 1, ok: true, records: [] });

    assert.deepEqual((await promise).records, []);
  });

  it('rejects with the error code from the host', async () => {
    const port = createFakePort();
    const client = createNativeClient(port);
    const promise = client.request({ op: 'read', id: 'doc_missing000', offset: 0 });

    port.emit({
      requestId: 1,
      ok: false,
      error: { code: 'not_found', message: 'No document with id "doc_missing000".' },
    });

    await assert.rejects(promise, (error) => {
      assert.equal(error.code, 'not_found');
      assert.match(error.message, /No document/);
      return true;
    });
  });

  it('keeps concurrent requests independent', async () => {
    const port = createFakePort();
    const client = createNativeClient(port);

    const first = client.request({ op: 'list' });
    const second = client.request({ op: 'ping' });

    assert.deepEqual(
      port.sent.map((message) => message.requestId),
      [1, 2],
    );

    port.emit({ requestId: 2, ok: true, hostVersion: '0.1.0' });
    port.emit({ requestId: 1, ok: true, records: [] });

    assert.deepEqual((await first).records, []);
    assert.equal((await second).hostVersion, '0.1.0');
  });

  it('rejects pending and new requests after a disconnect', async () => {
    const port = createFakePort();
    const client = createNativeClient(port, {
      describeDisconnect: () => 'Specified native messaging host not found.',
    });

    const first = client.request({ op: 'ping' });
    const second = client.request({ op: 'list' });

    port.emitDisconnect();

    await assert.rejects(first, /not found/);
    await assert.rejects(second, /not found/);
    assert.equal(client.closed, true);
    await assert.rejects(client.request({ op: 'ping' }), /not connected/);
  });

  it('times out a request that is never answered', async () => {
    const port = createFakePort();
    const client = createNativeClient(port, { timeoutMs: 10 });

    await assert.rejects(client.request({ op: 'ping' }), /did not answer/);
  });

  it('rejects pending requests when the client is closed', async () => {
    const port = createFakePort();
    const client = createNativeClient(port);
    const promise = client.request({ op: 'ping' });

    client.close();

    await assert.rejects(promise, /closed/);
    assert.equal(port.disconnected, true);
  });

  it('requires a port', () => {
    assert.throws(() => createNativeClient(null), /port/);
  });
});
