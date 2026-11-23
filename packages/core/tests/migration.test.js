import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planLegacyMigration } from '../src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';

describe('planLegacyMigration', () => {
  it('turns name-keyed blobs into records', () => {
    const blob = new Blob(['A'], { type: 'text/plain' });
    const plan = planLegacyMigration([{ name: 'a.txt', blob }], { now: NOW });

    assert.equal(plan.length, 1);
    assert.equal(plan[0].blob, blob);
    assert.equal(plan[0].record.name, 'a.txt');
    assert.equal(plan[0].record.size, 1);
    assert.equal(plan[0].record.mediaType, 'text/plain');
    assert.equal(plan[0].record.createdAt, NOW);
    assert.match(plan[0].record.id, /^doc_[0-9a-z]{10}$/);
  });

  it('keeps entries whose names collide apart', () => {
    const plan = planLegacyMigration(
      [
        { name: 'notes.txt', blob: new Blob(['one']) },
        { name: 'NOTES.txt', blob: new Blob(['two']) },
      ],
      { now: NOW },
    );

    assert.deepEqual(
      plan.map(({ record }) => record.name),
      ['notes.txt', 'NOTES (2).txt'],
    );
    assert.notEqual(plan[0].record.id, plan[1].record.id);
  });

  it('skips entries without a Blob', () => {
    const plan = planLegacyMigration([
      { name: 'a.txt', blob: new Blob(['A']) },
      { name: 'broken.txt', blob: 'not a blob' },
      { name: 'missing.txt' },
      null,
    ]);

    assert.deepEqual(
      plan.map(({ record }) => record.name),
      ['a.txt'],
    );
  });

  it('falls back to the blob name, then untitled', () => {
    const named = new Blob(['A']);
    named.name = 'from-blob.txt';

    const plan = planLegacyMigration([
      { blob: named },
      { blob: new Blob(['B']) },
    ]);

    assert.deepEqual(
      plan.map(({ record }) => record.name),
      ['from-blob.txt', 'untitled'],
    );
  });

  it('uses the supplied id factory', () => {
    let next = 0;
    const plan = planLegacyMigration(
      [
        { name: 'a.txt', blob: new Blob(['A']) },
        { name: 'b.txt', blob: new Blob(['B']) },
      ],
      { idFactory: () => `doc_test${String(next++).padStart(6, '0')}` },
    );

    assert.deepEqual(
      plan.map(({ record }) => record.id),
      ['doc_test000000', 'doc_test000001'],
    );
  });
});
