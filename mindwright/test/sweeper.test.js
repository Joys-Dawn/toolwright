// Coverage for lib/sweeper.js#sweepOnce — the recovery path for short-term
// rows written with embedding=NULL while the model daemon was down. Run
// best-effort at SessionStart. The orchestration has three failure modes
// that MUST be tolerated:
// (1) embedFn rejection → bail without state change, no propagation;
// (2) one vector is non-Float32Array → skip that row only;
// (3) writeEmbedding throws on row k → rows k+1..n still get processed.
// A regression in any of these silently leaves pending rows un-embedded
// and degrades retrieval recall over time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { sweepOnce } from '../lib/sweeper.js';

const EMBEDDING_DIM = 1024;

async function withStore(fn) {
  // Snapshot/restore MINDWRIGHT_PROJECT_ROOT so the env var doesn't leak.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-sweeper-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return await fn(store);
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) {
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    } else {
      process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    }
  }
}

function makeVec(seed) {
  // Deterministic, normalized-ish Float32Array of EMBEDDING_DIM.
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    v[i] = ((seed * 31 + i) % 200 - 100) / 1000;
  }
  return v;
}

function plantPending(store, count, sessionId = 'sweep-sess') {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = store.insertEntry({
      tier: 'short',
      kind: 'thinking',
      content: `pending row ${i}`,
      sessionId,
      // no embedding → row lands with vec_index empty for this rowid
    });
    ids.push(id);
  }
  return ids;
}

function hasEmbedding(store, id) {
  const rowid = typeof id === 'bigint' ? id : BigInt(id);
  const row = store.db.prepare('SELECT rowid FROM vec_index WHERE rowid = ?').get(rowid);
  return Boolean(row);
}

// ---------------------------------------------------------------
// happy path
// ---------------------------------------------------------------

test('sweepOnce embeds the full pending batch and writes each vector', async () => {
  await withStore(async (store) => {
    const ids = plantPending(store, 3);
    let embedCalls = 0;
    const embedFn = async (texts) => {
      embedCalls++;
      assert.equal(texts.length, 3, 'sweeper must batch all pending rows in one call');
      return texts.map((_, i) => makeVec(i));
    };
    await sweepOnce(store, embedFn);
    assert.equal(embedCalls, 1);
    for (const id of ids) {
      assert.equal(hasEmbedding(store, id), true, `row ${id} should have an embedding`);
    }
  });
});

// ---------------------------------------------------------------
// empty queue → no-op
// ---------------------------------------------------------------

test('sweepOnce on empty pending list is a no-op and never calls embedFn', async () => {
  await withStore(async (store) => {
    let embedCalls = 0;
    const embedFn = async () => { embedCalls++; return []; };
    await sweepOnce(store, embedFn);
    assert.equal(embedCalls, 0, 'embedFn must not be invoked when nothing is pending');
  });
});

// ---------------------------------------------------------------
// embedFn rejects → swallowed, no state change, no exception
// ---------------------------------------------------------------

test('sweepOnce swallows embedFn rejection without propagating or writing anything', async () => {
  await withStore(async (store) => {
    const ids = plantPending(store, 2);
    const embedFn = async () => { throw new Error('synthetic pipe error'); };
    // Must not throw — sweepOnce is the loop body of a setInterval, a
    // propagated error would silently kill the 60s sweep.
    await sweepOnce(store, embedFn);
    for (const id of ids) {
      assert.equal(hasEmbedding(store, id), false, `row ${id} should remain unembedded`);
    }
  });
});

// ---------------------------------------------------------------
// non-Float32Array result → skip the row, continue with the rest
// ---------------------------------------------------------------

test('sweepOnce isolates a poison row: batch-embed throws once, per-text retry lands the rest', async () => {
  // Regression: a single content payload that crashes the tokenizer used
  // to wedge the sweep loop — the batch threw, sweepOnce returned without
  // making progress, and the same 50 rows came back every tick. Now a
  // batch failure falls back to per-text embedding so the good rows still
  // land and only the poison row remains pending.
  await withStore(async (store) => {
    const ids = plantPending(store, 3);
    const poisonIdx = 1; // middle row
    let firstBatchCall = true;
    const embedFn = async (texts) => {
      // First call is the batch attempt — throws.
      if (firstBatchCall && texts.length > 1) {
        firstBatchCall = false;
        throw new Error('synthetic tokenizer crash on poison row');
      }
      // Per-text retries: throw on the poison text only.
      return texts.map((t, i) => {
        const sourceRowIdx = ids.findIndex((id) => {
          const r = store.fetch(id);
          return r && r.content === t;
        });
        if (sourceRowIdx === poisonIdx) {
          throw new Error('still poison');
        }
        const v = new Float32Array(1024);
        v.fill(0.5);
        return v;
      });
    };
    await sweepOnce(store, embedFn);
    // Non-poison rows must have landed.
    assert.equal(hasEmbedding(store, ids[0]), true, 'row 0 must be embedded after fallback');
    assert.equal(hasEmbedding(store, ids[2]), true, 'row 2 must be embedded after fallback');
    // Poison row remains pending (will retry next sweep tick).
    assert.equal(hasEmbedding(store, ids[poisonIdx]), false, 'poison row must remain unembedded');
  });
});

test('sweepOnce skips rows whose vector is not a Float32Array but continues the batch', async () => {
  await withStore(async (store) => {
    const ids = plantPending(store, 3);
    const embedFn = async (texts) => {
      const out = texts.map((_, i) => makeVec(i));
      out[1] = null; // simulate a degraded slot
      return out;
    };
    await sweepOnce(store, embedFn);
    assert.equal(hasEmbedding(store, ids[0]), true, 'row 0 should be embedded');
    assert.equal(hasEmbedding(store, ids[1]), false, 'row 1 should be skipped');
    assert.equal(hasEmbedding(store, ids[2]), true, 'row 2 should still be embedded');
  });
});

test('sweepOnce skips a vector whose length is not EMBEDDING_DIM (writeEmbedding throws)', async () => {
  await withStore(async (store) => {
    const ids = plantPending(store, 3);
    const embedFn = async (texts) => {
      const out = texts.map((_, i) => makeVec(i));
      out[1] = new Float32Array(10); // wrong length — writeEmbedding will throw
      return out;
    };
    await sweepOnce(store, embedFn);
    assert.equal(hasEmbedding(store, ids[0]), true, 'row 0 OK');
    assert.equal(hasEmbedding(store, ids[1]), false, 'row 1 throws inside writeEmbedding → skipped');
    assert.equal(hasEmbedding(store, ids[2]), true, 'row 2 continues after row 1 throws');
  });
});

// ---------------------------------------------------------------
// concurrent hard-delete — writeEmbedding must not orphan vec_index.
// The sweeper reads pending ids, awaits the embedder, then writes back.
// A concurrent hardDeleteShortTerm during that gap should not leave a
// stranded vec_index row with no matching entries.id.
// ---------------------------------------------------------------

test('sweepOnce skips rows whose entry was hard-deleted mid-embed (no vec_index orphan)', async () => {
  await withStore(async (store) => {
    const ids = plantPending(store, 3);
    const embedFn = async (texts) => {
      // Simulate the embedder taking long enough that a concurrent
      // hardDeleteShortTerm could fire — delete the middle row right now.
      store.hardDeleteShortTerm([ids[1]]);
      return texts.map((_, i) => makeVec(i));
    };
    await sweepOnce(store, embedFn);

    // Surviving rows must get their embedding.
    assert.equal(hasEmbedding(store, ids[0]), true, 'row 0 should be embedded');
    assert.equal(hasEmbedding(store, ids[2]), true, 'row 2 should be embedded');

    // The deleted row must NOT leave a vec_index orphan.
    const orphans = store.db.prepare(`
      SELECT v.rowid FROM vec_index v
      LEFT JOIN entries e ON e.id = v.rowid
      WHERE e.id IS NULL
    `).all();
    assert.equal(orphans.length, 0, 'no vec_index row may exist without a matching entries row');
  });
});

// ---------------------------------------------------------------
// batch size — never exceeds SWEEPER_BATCH (50). pendingEmbedSweep does the
// LIMIT itself; this test pins the contract that sweepOnce relies on it.
// ---------------------------------------------------------------

test('sweepOnce only operates on up to SWEEPER_BATCH rows per call', async () => {
  await withStore(async (store) => {
    plantPending(store, 60);
    let batchSize = 0;
    const embedFn = async (texts) => {
      batchSize = texts.length;
      return texts.map((_, i) => makeVec(i));
    };
    await sweepOnce(store, embedFn);
    assert.ok(batchSize <= 50, `batch size ${batchSize} must be <= SWEEPER_BATCH (50)`);
    assert.ok(batchSize > 0, 'sweepOnce must process at least one row when work is available');
  });
});

// ---------------------------------------------------------------
// poison-row exclusion — a row that fails to embed reliably must
// eventually drop out of the sweep queue so it stops blocking newer rows.
// ---------------------------------------------------------------

test('sweepOnce bumps embed_failures on per-row failure; row drops out of pendingEmbedSweep after threshold', async () => {
  // Regression: a row whose content reliably crashes the tokenizer was
  // re-tried oldest-first every 60s, wedging the head of the queue and
  // silently degrading recall on newer rows. The fix: bump
  // entries.embed_failures on each per-row failure, and exclude rows past
  // the threshold from pendingEmbedSweep.
  await withStore(async (store) => {
    const ids = plantPending(store, 1);
    const id = ids[0];
    const embedFn = async (texts) => {
      // Batch-level failure forces per-row retry; per-row also fails. Each
      // call should bump embed_failures by 1.
      throw new Error('synthetic tokenizer crash');
    };

    // First 5 sweeps: row stays pending but counter climbs.
    for (let i = 1; i <= 5; i++) {
      await sweepOnce(store, embedFn);
      const row = store.db.prepare('SELECT embed_failures FROM entries WHERE id = ?').get(BigInt(id));
      assert.equal(row.embed_failures, i, `after sweep ${i} embed_failures must equal ${i}`);
    }

    // After threshold: row is no longer returned by pendingEmbedSweep, so
    // the next sweep does NOT bump the counter (no work to do).
    const beforeBypass = store.db.prepare('SELECT embed_failures FROM entries WHERE id = ?').get(BigInt(id));
    await sweepOnce(store, embedFn);
    const afterBypass = store.db.prepare('SELECT embed_failures FROM entries WHERE id = ?').get(BigInt(id));
    assert.equal(afterBypass.embed_failures, beforeBypass.embed_failures,
      'rows past the retry threshold must not be picked up by pendingEmbedSweep anymore');

    // And status-side accounting reflects this.
    assert.equal(store.countPendingEmbeds(), 0, 'no rows under threshold remain');
    assert.equal(store.countPoisonEmbeds(), 1, 'one poison row past threshold');
  });
});

test('sweepOnce does NOT bump embed_failures for successfully-embedded rows', async () => {
  await withStore(async (store) => {
    const ids = plantPending(store, 3);
    const embedFn = async (texts) => texts.map((_, i) => makeVec(i));
    await sweepOnce(store, embedFn);
    for (const id of ids) {
      const row = store.db.prepare('SELECT embed_failures FROM entries WHERE id = ?').get(BigInt(id));
      assert.equal(row.embed_failures, 0, `embed_failures must stay 0 for embedded row ${id}`);
    }
  });
});

test('sweepOnce poison-row bookkeeping does not double-bump in the per-row retry path', async () => {
  // Regression-defense: the write loop must NOT bump again for rows the
  // per-row retry already handled — otherwise a single failed attempt
  // counts as 2, halving the effective retry budget.
  await withStore(async (store) => {
    const ids = plantPending(store, 2);
    const embedFn = async (texts) => {
      if (texts.length > 1) throw new Error('batch fails to force per-row retry');
      // Per-row retry — fail both.
      throw new Error('per-row also fails');
    };
    await sweepOnce(store, embedFn);
    for (const id of ids) {
      const row = store.db.prepare('SELECT embed_failures FROM entries WHERE id = ?').get(BigInt(id));
      assert.equal(row.embed_failures, 1, `each row must be bumped exactly once per sweep; got ${row.embed_failures}`);
    }
  });
});
