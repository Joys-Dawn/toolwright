// Tests for the TEMPR pipeline. Models are stubbed so this is fast + deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { retrieve } from '../lib/retriever.js';

async function withStore(fn) {
  // Snapshot/restore MINDWRIGHT_PROJECT_ROOT so the env var doesn't leak
  // across tests (matches the pattern used in session-liveness.test.js,
  // end-to-end.test.js, and cross-process-wal.test.js).
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-pipe-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) {
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    } else {
      process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    }
  }
}

function unit(seed) {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.cos(seed * (i + 1));
  let n = 0;
  for (let i = 0; i < 1024; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 1024; i++) v[i] /= n;
  return v;
}

const STUB_EMBED = async (texts) => texts.map((t, i) => unit(t.length + i));
const STUB_RERANK_ALL_HIGH = async (q, cs) => cs.map(() => 0.9);
const STUB_RERANK_ALL_LOW = async (q, cs) => cs.map(() => 0.05);

test('returns [] when the store is empty', async () => {
  await withStore(async (store) => {
    const out = await retrieve({
      store,
      queryText: 'hello',
      embed: STUB_EMBED,
      rerank: STUB_RERANK_ALL_HIGH,
    });
    assert.deepEqual(out, []);
  });
});

test('returns ranked results above rerank_floor', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact about the user preferring tabs', sessionId: 's',
      embedding: unit(3),
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'unrelated thought', sessionId: 's',
      embedding: unit(5),
    });
    const out = await retrieve({
      store,
      queryText: 'tabs',
      embed: STUB_EMBED,
      rerank: STUB_RERANK_ALL_HIGH,
    });
    assert.ok(out.length >= 1);
    for (const r of out) {
      assert.ok(r.rerank_score >= 0.75);
    }
  });
});

test('returned hits include created_at so the formatter can surface a ts= token', async () => {
  // Agents otherwise reason about time from a stale training cutoff. The
  // retriever exposes each row's stored ISO created_at so lib/recall-format.js
  // can render it as a machine-readable `ts=` token alongside other meta.
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'time-anchored fact', sessionId: 's', embedding: unit(3),
    });
    const out = await retrieve({
      store, queryText: 'time', embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
    });
    assert.ok(out.length >= 1);
    for (const r of out) {
      assert.equal(typeof r.created_at, 'string', `created_at must be a string, got ${r.created_at}`);
      assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T/,
        `created_at must be ISO-8601, got: ${r.created_at}`);
    }
  });
});

test('returns [] when all rerank scores fall below the floor', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a fact', sessionId: 's', embedding: unit(2),
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'b fact', sessionId: 's', embedding: unit(4),
    });
    const out = await retrieve({
      store,
      queryText: 'something else',
      embed: STUB_EMBED,
      rerank: STUB_RERANK_ALL_LOW,
    });
    assert.deepEqual(out, []);
  });
});

test('respects a custom k', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 10; i++) {
      store.insertEntry({
        tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
        content: `fact ${i}`, sessionId: 's', embedding: unit(i + 1),
      });
    }
    const out = await retrieve({
      store, queryText: 'fact', embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      options: { k: 3 },
    });
    assert.equal(out.length, 3);
  });
});

test('works without a reranker — falls back to score=1.0', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'something', sessionId: 's', embedding: unit(7),
    });
    const out = await retrieve({
      store, queryText: 'something',
      embed: STUB_EMBED,
      rerank: null,
    });
    assert.ok(out.length >= 1);
    // Exact 1.0 — matches the assertion shape used in the rerank=null and
    // rerank-short-array tests later in this file. A loose `>= 1.0` would
    // pass if a regression bumped the fallback to 1.5 or any positive value.
    assert.equal(out[0].rerank_score, 1.0,
      `expected fallback score 1.0, got ${out[0].rerank_score}`);
  });
});

test('recency boost lifts very recent items only', async () => {
  await withStore(async (store) => {
    const old = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'old fact', sessionId: 's', embedding: unit(1),
    });
    // Backdate the "old" row 60 days.
    store.db.prepare(
      'UPDATE entries SET created_at = ? WHERE id = ?',
    ).run(new Date(Date.now() - 60 * 86400 * 1000).toISOString(), old);

    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fresh fact', sessionId: 's', embedding: unit(2),
    });
    const out = await retrieve({
      store, queryText: 'fact',
      embed: STUB_EMBED,
      rerank: async (q, cs) => cs.map(() => 0.9), // tie above floor; boost is the only tiebreaker
      options: { recencyBoostMax: 0.05, recencyBoostDays: 14 },
    });
    // Fresh fact should now beat old fact.
    assert.equal(out[0].content, 'fresh fact');
  });
});

test('recency boost ranks on event_ts when present (a fresh-event_ts row beats an old-event_ts one)', async () => {
  // The seeding overhaul's recency requirement: a row distilled from an old
  // historical exchange (old event_ts) must NOT outrank a semantically-equal
  // row from a recent exchange just because both were WRITTEN (created_at)
  // at the same seed-run time. The boost must read event_ts, not created_at.
  await withStore(async (store) => {
    // Both rows get created_at = now (same seed-run write time). Only
    // event_ts differs: `stale` happened 60 days ago, `recent` just now.
    const stale = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact alpha', sessionId: 's', embedding: unit(1),
      eventTs: new Date(Date.now() - 60 * 86400 * 1000).toISOString(),
    });
    const recent = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact beta', sessionId: 's', embedding: unit(2),
      eventTs: new Date().toISOString(),
    });
    const out = await retrieve({
      store, queryText: 'fact',
      embed: STUB_EMBED,
      rerank: async (q, cs) => cs.map(() => 0.9), // tie above floor; boost is the only tiebreaker
      options: { recencyBoostMax: 0.05, recencyBoostDays: 14 },
    });
    // The recent-event_ts row must lead despite identical created_at.
    assert.equal(Number(out[0].id), Number(recent),
      `event_ts must drive the recency boost; got order ${JSON.stringify(out.map((r) => Number(r.id)))} (stale=${Number(stale)} recent=${Number(recent)})`);
  });
});

test('a future-dated event_ts gets NO recency boost (clock-skew guard), not the maximum', async () => {
  // Regression: event_ts is taken verbatim from JSONL rec.timestamp /
  // frontmatter / mtime with no upper clamp. On a multi-machine setup
  // (transcripts synced between a laptop and a second machine whose clock
  // is ahead) a seeded row can carry an event_ts in the future relative to
  // the recalling machine. The old `ageDays <= 0` branch handed such a row
  // the MAXIMUM boost, floating a stale fragment above genuinely fresh
  // facts on every recall. created_at is monotonic so this path was
  // unreachable before the seeding overhaul — a new failure mode the guard
  // closes by treating a future age as "no credible recency signal" (0).
  await withStore(async (store) => {
    // Same created_at (seed-run write time); only event_ts differs.
    const genuinelyRecent = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact alpha', sessionId: 's', embedding: unit(1),
      eventTs: new Date(Date.now() - 3 * 86400 * 1000).toISOString(), // 3d ago — real, partial boost
    });
    const futureSkewed = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact beta', sessionId: 's', embedding: unit(2),
      eventTs: new Date(Date.now() + 30 * 86400 * 1000).toISOString(), // +30d — clock-skewed
    });
    const out = await retrieve({
      store, queryText: 'fact',
      embed: STUB_EMBED,
      rerank: async (q, cs) => cs.map(() => 0.9), // tie above floor; boost is the only tiebreaker
      options: { recencyBoostMax: 0.05, recencyBoostDays: 14 },
    });
    // Pre-fix: futureSkewed got maxBoost (0.05) > genuinelyRecent's ~0.039
    // → led. Post-fix: futureSkewed gets 0 → genuinelyRecent leads.
    assert.equal(Number(out[0].id), Number(genuinelyRecent),
      `a future event_ts must not earn the max boost; got order ${JSON.stringify(out.map((r) => Number(r.id)))} (recent=${Number(genuinelyRecent)} futureSkewed=${Number(futureSkewed)})`);
  });
});

test('recency boost falls back to created_at when event_ts is NULL (zero-regression for live rows)', async () => {
  // Every existing live row has event_ts = NULL. The boost must behave
  // EXACTLY as before the column existed — drive off created_at via the
  // `event_ts ?? created_at` fallback. (Mirror of the pre-change
  // "recency boost lifts very recent items only" test, asserting the
  // NULL-event_ts path is unchanged.)
  await withStore(async (store) => {
    const old = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'old fact', sessionId: 's', embedding: unit(1),
    });
    store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 86400 * 1000).toISOString(), old);
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fresh fact', sessionId: 's', embedding: unit(2),
    });
    const out = await retrieve({
      store, queryText: 'fact',
      embed: STUB_EMBED,
      rerank: async (q, cs) => cs.map(() => 0.9), // tie above floor; boost is the only tiebreaker
      options: { recencyBoostMax: 0.05, recencyBoostDays: 14 },
    });
    assert.equal(out[0].content, 'fresh fact',
      'NULL event_ts must fall back to created_at — identical to pre-change behavior');
  });
});

test('a fresh event_ts cannot resurrect a row whose raw rerank is below the floor', async () => {
  // The recency boost is ORDERING-only: the abstention floor still gates on
  // RAW rerank. A seeded row with a brand-new event_ts but an irrelevant
  // body (sub-floor rerank) must NOT be dragged back into results by the
  // boost. Preserves the rerank-floor / ordering-score separation.
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'totally irrelevant content', sessionId: 's', embedding: unit(2),
      eventTs: new Date().toISOString(), // maximally fresh
    });
    const out = await retrieve({
      store, queryText: 'something unrelated',
      embed: STUB_EMBED,
      rerank: STUB_RERANK_ALL_LOW, // every raw rerank below 0.75 floor
      options: { recencyBoostMax: 0.05, recencyBoostDays: 14 },
    });
    assert.deepEqual(out, [],
      'fresh event_ts must not lift a sub-floor row over the abstention floor');
  });
});

// Seed BOTH tiers with >10 rows so each tier-specific retrieve actually has
// candidates to slice. Without this, a tier='short' query against a long-only
// corpus would return [] before the spy ever ran, masking the rerank-cap
// assertion.
function seedBothTiers(store) {
  for (let i = 0; i < 15; i++) {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: `long fact ${i} about tabs`, sessionId: 's',
      embedding: unit(i + 1),
    });
    store.insertEntry({
      tier: 'short', kind: 'thinking',
      content: `short thought ${i} about tabs`, sessionId: 's',
      embedding: unit(100 + i),
    });
  }
}

test('rrfTopForRerank defaults to 5 for tier=short / null (capping the per-turn rerank wall time)', async () => {
  // The throttle on cross-encoder wall time for every hook turn. A regression
  // that flipped the default to 10 would silently double rerank cost on
  // every PreToolUse/UserPromptSubmit pass; a regression to 1 would starve
  // recall to a single candidate. Seed enough rows in both tiers to exceed
  // both defaults so the cap actually slices.
  await withStore(async (store) => {
    seedBothTiers(store);
    let seenCount = -1;
    const spy = async (q, cs) => { seenCount = cs.length; return cs.map(() => 0.9); };
    // tier=null (default) → short cap (mixed-tier callers still pay the
    // short-cap default; only an explicit tier='long' opts into the deeper
    // rerank).
    await retrieve({ store, queryText: 'tabs', embed: STUB_EMBED, rerank: spy });
    assert.equal(seenCount, 5,
      `tier=null must pass at most RRF_TOP_FOR_RERANK_SHORT (5) candidates to rerank, got ${seenCount}`);

    // tier='short' → same cap.
    seenCount = -1;
    await retrieve({ store, queryText: 'tabs', tier: 'short', embed: STUB_EMBED, rerank: spy });
    assert.equal(seenCount, 5,
      `tier='short' must pass at most 5 candidates to rerank, got ${seenCount}`);
  });
});

test('rrfTopForRerank defaults to 10 for tier=long (deeper rerank for the rarer long-tier path)', async () => {
  await withStore(async (store) => {
    seedBothTiers(store);
    let seenCount = -1;
    const spy = async (q, cs) => { seenCount = cs.length; return cs.map(() => 0.9); };
    await retrieve({ store, queryText: 'tabs', tier: 'long', embed: STUB_EMBED, rerank: spy });
    assert.equal(seenCount, 10,
      `tier='long' must pass at most RRF_TOP_FOR_RERANK_LONG (10) candidates to rerank, got ${seenCount}`);
  });
});

test('explicit options.rrfTopForRerank overrides the per-tier default for both tiers', async () => {
  await withStore(async (store) => {
    seedBothTiers(store);
    let seenCount = -1;
    const spy = async (q, cs) => { seenCount = cs.length; return cs.map(() => 0.9); };
    // Explicit 3 — tighter than both tier defaults.
    await retrieve({
      store, queryText: 'tabs', tier: 'long',
      embed: STUB_EMBED, rerank: spy, options: { rrfTopForRerank: 3 },
    });
    assert.equal(seenCount, 3,
      `explicit options.rrfTopForRerank=3 must beat the tier=long default of 10, got ${seenCount}`);

    // Same override from the short-tier path.
    seenCount = -1;
    await retrieve({
      store, queryText: 'tabs', tier: 'short',
      embed: STUB_EMBED, rerank: spy, options: { rrfTopForRerank: 3 },
    });
    assert.equal(seenCount, 3,
      `explicit options.rrfTopForRerank=3 must beat the tier=short default of 5, got ${seenCount}`);
  });
});

test('retrieve() return object carries event_ts (feeds recall-format ts= token)', async () => {
  // The real recency-surfacing projection is the retrieve() return-object
  // literal, NOT store.fetch. If event_ts is missing here, recall-format
  // silently keeps emitting created_at (seed-run time) for every seeded row.
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact with provenance', sessionId: 's', embedding: unit(3),
      eventTs: '2025-02-03T04:05:06.000Z',
    });
    const out = await retrieve({
      store, queryText: 'provenance', embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
    });
    assert.ok(out.length >= 1);
    assert.equal(out[0].event_ts, '2025-02-03T04:05:06.000Z',
      'retrieve() must surface event_ts in its return literal');
    // created_at still present and distinct (write time).
    assert.equal(typeof out[0].created_at, 'string');
    assert.notEqual(out[0].created_at, out[0].event_ts);
  });
});

test('retrieve() return object event_ts is null for live rows (no fabricated provenance)', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a live fact', sessionId: 's', embedding: unit(4),
    });
    const out = await retrieve({
      store, queryText: 'live', embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
    });
    assert.ok(out.length >= 1);
    assert.equal(out[0].event_ts, null,
      'a row with no source event time must surface event_ts=null, not a guess');
  });
});

test('rrf_score stays paired with the correct row when one fetch returns null', async () => {
  // Regression: previously `rows = topForRerank.map(fetch).filter(Boolean)`
  // and `topForRerank[idx]` mixed pre-filter and post-filter indices, so a
  // hard-deleted row would shift every later row's rrf_score onto the wrong
  // entry. The fix pairs entry+row before filtering.
  await withStore(async (store) => {
    const id1 = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'alpha fact', sessionId: 's', embedding: unit(11),
    });
    const id2 = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'beta fact', sessionId: 's', embedding: unit(12),
    });
    const id3 = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'gamma fact', sessionId: 's', embedding: unit(13),
    });

    // Hard-delete row 2 to force the missing-row branch inside retrieve().
    // sqlite-vec rows go through entries' cascade; we DELETE FROM entries.
    store.db.prepare('DELETE FROM entries WHERE id = ?').run(id2);

    const out = await retrieve({
      store, queryText: 'fact',
      embed: STUB_EMBED,
      rerank: STUB_RERANK_ALL_HIGH,
      options: { k: 5 },
    });
    // Every returned row must have a finite, non-negative rrf_score paired
    // with itself — not the deleted row's slot.
    assert.ok(out.length >= 2, `expected >=2 rows, got ${out.length}`);
    for (const r of out) {
      assert.ok(
        typeof r.rrf_score === 'number' && r.rrf_score >= 0 && Number.isFinite(r.rrf_score),
        `bad rrf_score for id=${r.id}: ${r.rrf_score}`,
      );
      assert.notEqual(r.id, id2, 'deleted row must not appear in results');
    }
  });
});

test('soft-archived rows are not returned', async () => {
  await withStore(async (store) => {
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'will be archived', sessionId: 's', embedding: unit(9),
    });
    store.softArchive(id);
    const out = await retrieve({
      store, queryText: 'archived', embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
    });
    assert.deepEqual(out, []);
  });
});

// ----- role scoping (procedural / role:<role>) ------------------------------
// DESIGN.md promises retrieval is "filtered by (tier, category, scope)
// predicates that include the session's active roles." The
// /mindwright:assign-role skill body docs that role assignment controls
// which heuristics get injected. These tests pin that behavior end-to-end
// through retrieve(), which delegates to scopeFilterClause.

test('roles=[X] scopes procedural/role:<role> rows to role X but leaves other scopes alone', async () => {
  await withStore(async (store) => {
    const plannerHeur = store.insertEntry({
      tier: 'long', category: 'procedural', kind: 'fact',
      content: 'planner heuristic', sessionId: 's', scope: 'role:planner', embedding: unit(1),
    });
    const consolidatorHeur = store.insertEntry({
      tier: 'long', category: 'procedural', kind: 'fact',
      content: 'consolidator heuristic', sessionId: 's', scope: 'role:consolidator', embedding: unit(2),
    });
    const projectFact = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'project uses TypeScript', sessionId: 's', embedding: unit(3),
    });
    const userPref = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'user prefers tabs', sessionId: 's', confidence: 0.9, embedding: unit(4),
    });
    const out = await retrieve({
      store, queryText: 'anything',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      roles: ['planner'],
      options: { k: 20 },
    });
    const ids = new Set(out.map((h) => Number(h.id)));
    assert.ok(ids.has(plannerHeur), 'planner heuristic must be included when roles=[planner]');
    assert.ok(!ids.has(consolidatorHeur), 'consolidator heuristic must be excluded when roles=[planner]');
    assert.ok(ids.has(projectFact), 'fact/project must always pass through');
    assert.ok(ids.has(userPref), 'fact/user must always pass through');
  });
});

test('roles=[] (session has no assigned roles) excludes every role-scoped row', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'procedural', kind: 'fact',
      content: 'a heuristic', sessionId: 's', scope: 'role:planner', embedding: unit(1),
    });
    store.insertEntry({
      tier: 'long', category: 'procedural', kind: 'fact',
      content: 'another heuristic', sessionId: 's', scope: 'role:consolidator', embedding: unit(2),
    });
    const pf = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a project fact', sessionId: 's', embedding: unit(3),
    });
    const out = await retrieve({
      store, queryText: 'anything',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      roles: [],
      options: { k: 20 },
    });
    const ids = new Set(out.map((h) => Number(h.id)));
    assert.ok(ids.has(pf), 'fact/project still passes when roles is empty');
    for (const h of out) {
      assert.ok(
        !(h.scope && String(h.scope).startsWith('role:')),
        'no role-scoped rows must surface for roles=[]',
      );
    }
  });
});

test('roles omitted (null/undefined) leaves legacy behavior — all role-scoped rows pass', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'procedural', kind: 'fact',
      content: 'planner heuristic', sessionId: 's', scope: 'role:planner', embedding: unit(1),
    });
    store.insertEntry({
      tier: 'long', category: 'procedural', kind: 'fact',
      content: 'consolidator heuristic', sessionId: 's', scope: 'role:consolidator', embedding: unit(2),
    });
    const out = await retrieve({
      store, queryText: 'anything',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      options: { k: 20 },
    });
    const roleProcCount = out.filter((h) =>
      h.category === 'procedural' && h.scope && String(h.scope).startsWith('role:')
    ).length;
    assert.equal(roleProcCount, 2, 'omitting roles must NOT filter role-scoped procedural rows');
  });
});

test('excludeIds filters self-echo rows (UPS / PreToolUse just-flushed prompt or thinking)', async () => {
  // Regression for behavior-10: UPS / PreToolUse flush the user's prompt
  // (or the assistant's just-emitted thinking) into short-term BEFORE
  // running retrieval. semanticSearch misses the new row (NULL embedding),
  // but bm25Search and temporalSearch surface it, and the cross-encoder
  // scores (query, identical-candidate) ~1.0 — well above the 0.75 floor.
  // Without excludeIds, the user's own prompt echoes back as additionalContext.
  await withStore(async (store) => {
    // Plant a genuinely useful long-term hit AND the self-echo short-term row.
    const factId = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'the user prefers tabs over spaces',
      sessionId: 's', embedding: unit(11),
    });
    const selfPromptId = store.insertEntry({
      tier: 'short', kind: 'cli_prompt',
      content: 'do we use tabs or spaces?',
      sessionId: 's', // NULL embedding — chunker doesn't embed
    });

    // Without excludeIds: the just-flushed cli_prompt comes back.
    const withoutExclude = await retrieve({
      store, queryText: 'do we use tabs or spaces?',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
    });
    const baselineIds = withoutExclude.map((r) => Number(r.id));
    assert.ok(baselineIds.includes(Number(selfPromptId)),
      `prep: without excludeIds, the self-echo row IS surfaced (this is the bug); got ${JSON.stringify(baselineIds)}`);

    // With excludeIds: the self-echo row is dropped, the genuine fact stays.
    const withExclude = await retrieve({
      store, queryText: 'do we use tabs or spaces?',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      excludeIds: [Number(selfPromptId)],
    });
    const filteredIds = withExclude.map((r) => Number(r.id));
    assert.ok(!filteredIds.includes(Number(selfPromptId)),
      `excludeIds must drop the self-echo row; got ${JSON.stringify(filteredIds)}`);
    assert.ok(filteredIds.includes(Number(factId)),
      `non-excluded relevant rows must still surface; got ${JSON.stringify(filteredIds)}`);
  });
});

test('excludeIds=null / [] leaves the candidate pool untouched (no regression on non-hook callers)', async () => {
  // The mindwright_recall MCP tool does not pass excludeIds (it's a query
  // tool, not a hook). Pin that omitting / nulling the param leaves the
  // pre-fix behavior intact.
  await withStore(async (store) => {
    const factId = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a relevant fact', sessionId: 's', embedding: unit(13),
    });
    const out1 = await retrieve({
      store, queryText: 'relevant',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
    });
    const out2 = await retrieve({
      store, queryText: 'relevant',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      excludeIds: [],
    });
    const ids1 = out1.map((r) => Number(r.id));
    const ids2 = out2.map((r) => Number(r.id));
    assert.deepEqual(ids2, ids1, 'excludeIds=[] must behave identically to omitted');
    assert.ok(ids1.includes(Number(factId)));
  });
});

test('short-term rows pass through the role filter regardless of roles value', async () => {
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'a recent thought',
      sessionId: 's', embedding: unit(7),
    });
    const out = await retrieve({
      store, queryText: 'thought',
      embed: STUB_EMBED, rerank: STUB_RERANK_ALL_HIGH,
      roles: [],
      options: { k: 5 },
    });
    assert.ok(out.length > 0, 'short-term rows have no category and must not be touched by role filter');
    assert.equal(out[0].tier, 'short');
  });
});

test('rerank returning null (pipe degraded) falls back to 1.0-per-row instead of crashing', async () => {
  // Regression: lib/pipe-client.js#rerank returns null on connect-fail /
  // timeout / malformed response. Without a guard, retrieve() would NPE on
  // rerankScores[idx] and the caller's try/catch would swallow it into an
  // empty-results turn that looks like rerank-floor abstention. Verify the
  // null branch falls back to score=1.0 per row so results still surface.
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact one', sessionId: 's', embedding: unit(1),
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'fact two', sessionId: 's', embedding: unit(2),
    });
    const out = await retrieve({
      store,
      queryText: 'anything',
      embed: STUB_EMBED,
      rerank: async () => null, // simulates a pipe-degraded reranker
    });
    assert.ok(out.length > 0, 'null rerank must not zero the result list');
    // Every surfaced hit should carry the fallback rerank_score=1.0.
    for (const h of out) {
      assert.equal(h.rerank_score, 1.0, `expected fallback score 1.0, got ${h.rerank_score}`);
    }
  });
});

test('rerank returning a short array (length < rows.length) falls back to 1.0-per-row', async () => {
  // Regression: a reranker that returns a partial array (e.g., timed-out
  // mid-batch) would otherwise leave rerankScores[idx] === undefined for
  // the tail, and `undefined >= rerank_floor` silently drops those rows.
  // Worse, the tail's orderingScore becomes NaN and any caller-side metric
  // that aggregates rerank_score sees NaN. Treat length mismatch the same
  // as a null response — fall back to 1.0 per row so the result set stays
  // RRF-ordered for this turn rather than silently truncating.
  await withStore(async (store) => {
    for (let i = 1; i <= 4; i++) {
      store.insertEntry({
        tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
        content: `fact ${i}`, sessionId: 's', embedding: unit(i),
      });
    }
    const out = await retrieve({
      store,
      queryText: 'anything',
      embed: STUB_EMBED,
      // Returns 2 scores even though there are 4 rows — simulates a partial
      // response from a flaky reranker.
      rerank: async () => [0.9, 0.8],
    });
    assert.ok(out.length > 0, 'short rerank array must not zero the result list');
    for (const h of out) {
      assert.equal(h.rerank_score, 1.0, `expected fallback score 1.0, got ${h.rerank_score}`);
    }
  });
});
