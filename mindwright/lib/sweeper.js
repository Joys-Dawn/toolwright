// Deferred-embed sweeper.
//
// Hooks that fired while the machine model daemon was down/booting insert
// short-term rows with a NULL embedding (the documented degrade-to-null
// path). This back-fills a bounded batch of them so retrieval recall stays
// honest. It used to live inside the per-session MCP server on a 60s loop;
// the MCP server is gone, so a single bounded sweep runs best-effort at
// SessionStart (and degraded rows are now rare anyway — every hook that hits
// a down daemon lazily respawns it, so subsequent writes embed live rather
// than deferring).
//
// Designed to NEVER throw: embedFn rejection, per-vector type mismatch, and
// per-row writeEmbedding errors are all logged and swallowed so a transient
// failure can't break the SessionStart turn.

export const SWEEPER_BATCH = 50;

export async function sweepOnce(store, embedFn, batch = SWEEPER_BATCH) {
  const pending = store.pendingEmbedSweep(batch);
  if (!pending.length) return;
  const texts = pending.map((r) => r.content);
  let vectors;
  // alreadyBumped[i] is true when the per-row retry path already incremented
  // the failure counter for pending[i] — prevents double-bumping below.
  const alreadyBumped = new Array(pending.length).fill(false);
  try {
    vectors = await embedFn(texts);
  } catch (err) {
    // A single poison row (tokenizer-crashing / oversized content) must not
    // wedge the whole batch: fall back to per-text so the rest still lands;
    // texts that still fail get embed_failures bumped and eventually drop
    // out of pendingEmbedSweep.
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
