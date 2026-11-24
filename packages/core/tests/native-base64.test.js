import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { base64ToBytes, bytesToBase64 } from '../src/index.js';

describe('native base64 helpers', () => {
  it('round-trips empty input', () => {
    assert.equal(bytesToBase64(new Uint8Array()), '');
    assert.deepEqual(base64ToBytes(''), new Uint8Array());
  });

  it('round-trips a short value', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  });

  it('round-trips a value larger than one conversion slice', () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);

    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  });
});
