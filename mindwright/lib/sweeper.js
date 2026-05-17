// Deferred-embed sweeper. Hooks that fired while the model daemon was
// down/booting insert NULL-embedding rows (degrade-to-null path); this
// back-fills a bounded batch at SessionStart so recall stays honest.
// NEVER throws — every failure (embedFn rejection, type mismatch, per-row
// writeEmbedding) is logged and swallowed.

export const SWEEPER_BATCH = 50;

export async function sweepOnce(store, embedFn, batch = SWEEPER_BATCH) {
  const pending = store.pendingEmbedSweep(batch);
  if (!pending.length) return;
  const texts = pending.map((r) => r.content);
  let vectors;
  // True once the per-row retry already bumped pending[i] — avoids double-bump.
  const alreadyBumped = new Array(pending.length).fill(false);
  try {
    vectors = await embedFn(texts);
  } catch (err) {
    // A single poison row must not wedge the batch: fall back to per-text;
    // persistent failures bump embed_failures and drop out of the sweep.
    process.stderr.write(
      `[mindwright/sweeper] batch-embed failed, retrying per-text: ${err && err.message ? err.message : err}\n`
    );
    vectors = new Array(pending.length).fill(null);
    for (let i = 0; i < pending.length; i++) {
      try {
        const single = await embedFn([texts[i]]);
        if (Array.isArray(single) && single[0] instanceof Float32Array) {
          vectors[i] = single[0];
        } else {
          try { store.bumpEmbedFailure(pending[i].id); alreadyBumped[i] = true; } catch { /* */ }
        }
      } catch (perRowErr) {
        process.stderr.write(
          `[mindwright/sweeper] per-text embed failed for id=${pending[i].id}: ${perRowErr && perRowErr.message ? perRowErr.message : perRowErr}\n`
        );
        try { store.bumpEmbedFailure(pending[i].id); alreadyBumped[i] = true; } catch { /* */ }
      }
    }
  }
  for (let i = 0; i < pending.length; i++) {
    const v = vectors[i];
    if (!(v instanceof Float32Array)) {
      if (!alreadyBumped[i]) {
        try { store.bumpEmbedFailure(pending[i].id); } catch { /* */ }
      }
      continue;
    }
    try {
      store.writeEmbedding(pending[i].id, v);
    } catch (err) {
      process.stderr.write(
        `[mindwright/sweeper] writeEmbedding failed for id=${pending[i].id}: ${err && err.message ? err.message : err}\n`
      );
      try { store.bumpEmbedFailure(pending[i].id); } catch { /* */ }
    }
  }
}
