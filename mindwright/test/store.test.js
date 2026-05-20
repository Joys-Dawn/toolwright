// Unit tests for lib/store.js. These exercise the DB directly via in-memory or
// tmp-file SQLite — no models, no daemon, no transcripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, quantizeToInt8 } from '../lib/store.js';

function withStore(fn) {
  // Snapshot/restore MINDWRIGHT_PROJECT_ROOT so the env var doesn't leak
  // across tests, and doesn't end up pointing at a deleted tmp dir.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-test-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return fn(store, dir);
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

function fixedEmbedding(seed = 1) {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = (Math.sin(i * seed) + 1) / 2 - 0.5;
  // Normalize
  let n = 0;
  for (let i = 0; i < 1024; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 1024; i++) v[i] /= n;
  return v;
}

test('migrations are idempotent — opening twice does not throw', () => {
  withStore((store) => {
    const dir = process.env.MINDWRIGHT_PROJECT_ROOT;
    store.close();
    process.env.MINDWRIGHT_PROJECT_ROOT = dir;
    const store2 = openStore();
    store2.close();
  });
});

test('insertEntry returns an id and round-trips via fetch', () => {
  withStore((store) => {
    const id = store.insertEntry({
      tier: 'short',
      kind: 'cli_prompt',
      content: 'hello world',
      sessionId: 'sess-1',
    });
    assert.ok(typeof id === 'bigint' || typeof id === 'number');
    const row = store.fetch(id);
    assert.equal(row.content, 'hello world');
    assert.equal(row.kind, 'cli_prompt');
    assert.equal(row.tier, 'short');
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.active, 1);
  });
});

test('insertEntry persists eventTs when given, NULL otherwise (provenance time)', () => {
  withStore((store) => {
    // With eventTs — durable provenance time carried from a historical
    // transcript. created_at remains the write time (independent axis).
    const withTs = store.insertEntry({
      tier: 'short',
      kind: 'seed',
      content: 'distilled from a 2025 session',
      sessionId: 'sess-seed',
      eventTs: '2025-03-14T09:26:53.000Z',
    });
    const a = store.fetch(withTs);
    assert.equal(a.event_ts, '2025-03-14T09:26:53.000Z');
    assert.ok(a.created_at && a.created_at !== a.event_ts,
      'created_at is the write time, not the event time');

    // Without eventTs — column defaults to NULL so the row behaves exactly as
    // before this column existed (retrieval recency COALESCEs to created_at).
    const noTs = store.insertEntry({
      tier: 'short',
      kind: 'cli_prompt',
      content: 'live-captured, no event time',
      sessionId: 'sess-live',
    });
    const b = store.fetch(noTs);
    assert.equal(b.event_ts, null);
    // Backward-compat: the rest of the row is unaffected by the new column.
    assert.equal(b.content, 'live-captured, no event time');
    assert.equal(b.tier, 'short');
    assert.equal(b.active, 1);
  });
});

test('store.temporalSearch orders by COALESCE(event_ts, created_at); NULL event_ts behaves exactly as pre-change', () => {
  withStore((store) => {
    // A: inserted FIRST (oldest created_at) but carries a FAR-FUTURE
    // event_ts. Under a pure created_at DESC ordering it would rank last;
    // under COALESCE(event_ts, created_at) DESC it ranks FIRST — that flip
    // is the proof event_ts governs recency when present.
    const a = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'historical fact, recent underlying event', sessionId: 's',
      eventTs: '2099-01-01T00:00:00.000Z',
    });
    const b = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'live fact, no event time', sessionId: 's',
    });
    const ord = store.temporalSearch(10).map((r) => Number(r.id));
    assert.deepEqual(ord, [Number(a), Number(b)],
      'row with newer event_ts must rank first even though its created_at is older');

    // Zero-regression: rows with NULL event_ts fall back to
    // (created_at DESC, id DESC) — byte-identical to behavior before this
    // column existed. c then d inserted; d (higher id / newest) precedes c.
    const c = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'c no ts', sessionId: 's',
    });
    const d = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'd no ts', sessionId: 's',
    });
    const ord2 = store.temporalSearch(10).map((r) => Number(r.id));
    assert.equal(ord2[0], Number(a), 'the event_ts row still leads overall');
    const nullRowOrder = ord2.filter((id) => id === Number(c) || id === Number(d));
    assert.deepEqual(nullRowOrder, [Number(d), Number(c)],
      'NULL-event_ts rows keep created_at DESC, id DESC order — zero regression');
  });
});

test('FTS5 indexes inserted content and survives soft-archive', () => {
  withStore((store) => {
    const id = store.insertEntry({
      tier: 'long',
      category: 'fact', scope: 'project',
      kind: 'fact',
      content: 'the kingdom of foobar uses lazy-load caching',
      sessionId: 'sess-1',
    });
    const hits = store.bm25Search('foobar', 5);
    assert.equal(hits.length, 1);
    assert.equal(BigInt(hits[0].id), BigInt(id));

    // soft-archive removes from search (active=1 filter)
    store.softArchive(id);
    const after = store.bm25Search('foobar', 5);
    assert.equal(after.length, 0);
  });
});

test('FTS update trigger only fires on content changes (entries_au narrowing)', () => {
  // Regression for the narrowed entries_au trigger (0001_init.sql): non-content
  // column updates (active, supersedes, embed_failures, ...) must NOT trigger an
  // FTS5 delete+reinsert. We assert two properties:
  //   1. Searching by the unchanged body still hits after we touch a non-
  //      content column.
  //   2. Editing `content` continues to propagate to FTS5 — the new row
  //      becomes searchable and the old body does not.
  withStore((store) => {
    const id = store.insertEntry({
      tier: 'long',
      category: 'fact', scope: 'project',
      kind: 'fact',
      content: 'mockingbird canyon stratigraphic survey',
      sessionId: 'sess-1',
    });

    // (1) Non-content UPDATE — bump embed_failures the way the sweeper does.
    store.db.prepare('UPDATE entries SET embed_failures = embed_failures + 1 WHERE id = ?').run(id);
    const stillFound = store.bm25Search('mockingbird', 5);
    assert.equal(stillFound.length, 1, 'non-content UPDATE must not wipe FTS rows');
    assert.equal(BigInt(stillFound[0].id), BigInt(id));

    // (2) Content edit — must propagate.
    store.db.prepare('UPDATE entries SET content = ? WHERE id = ?')
      .run('replaced body about geomagnetic flux', id);
    assert.equal(store.bm25Search('mockingbird', 5).length, 0, 'old body must be evicted from FTS');
    const reindexed = store.bm25Search('geomagnetic', 5);
    assert.equal(reindexed.length, 1, 'new body must be searchable');
    assert.equal(BigInt(reindexed[0].id), BigInt(id));
  });
});

test('tier ⇄ (category, scope) partition CHECK rejects invalid combinations', () => {
  // Regression: the views and consolidator/retain code assume:
  //   short → category NULL (or 'raw'), scope NULL
  //   long  → category IN ('procedural','episodic','fact'), scope NOT NULL
  //           (scope is 'user' | 'project' | 'role:<role>')
  // The composite CHECK (0001_init.sql) makes the DB enforce that contract.
  withStore((store) => {
    // (a) valid combinations succeed
    const shortId = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'short row', sessionId: 'sess-1',
    });
    assert.ok(shortId, 'short tier with NULL category/scope must succeed');
    const longId = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'long row', sessionId: 'sess-1',
    });
    assert.ok(longId, 'long tier with valid (category, scope) must succeed');
    const longProc = store.insertEntry({
      tier: 'long', category: 'procedural', scope: 'role:planner', kind: 'fact',
      content: 'planner procedure', sessionId: 'sess-1',
    });
    assert.ok(longProc, 'long + procedural + role:<role> must succeed');

    // (b) invalid combinations are rejected at the DB layer
    assert.throws(
      () => store.db
        .prepare(`INSERT INTO entries(tier, category, scope, kind, content, session_id, created_at)
                  VALUES ('short', 'fact', 'user', 'x', 'y', 'sess-1', '2026-01-01')`)
        .run(),
      /CHECK constraint failed/i,
      'short tier with non-raw category must be rejected',
    );
    assert.throws(
      () => store.db
        .prepare(`INSERT INTO entries(tier, category, scope, kind, content, session_id, created_at)
                  VALUES ('long', NULL, 'project', 'fact', 'z', 'sess-1', '2026-01-01')`)
        .run(),
      /CHECK constraint failed/i,
      'long + NULL category must be rejected',
    );
    assert.throws(
      () => store.db
        .prepare(`INSERT INTO entries(tier, category, scope, kind, content, session_id, created_at)
                  VALUES ('long', 'fact', NULL, 'fact', 'q', 'sess-1', '2026-01-01')`)
        .run(),
      /CHECK constraint failed/i,
      'long + NULL scope must be rejected',
    );
    assert.throws(
      () => store.db
        .prepare(`INSERT INTO entries(tier, category, scope, kind, content, session_id, created_at)
                  VALUES ('long', 'fact', 'banana', 'fact', 'r', 'sess-1', '2026-01-01')`)
        .run(),
      /CHECK constraint failed/i,
      'long + invalid scope literal must be rejected',
    );
  });
});

test('self-supersedes are rejected by DB CHECK constraints', () => {
  // Regression for the no-self-cycle invariant. If a stray retain/merge call
  // ever supplied the same id twice, the supersede graph traversal would
  // loop indefinitely. The two CHECK constraints (entries.supersedes and
  // entry_supersedes.{new,old}_id) make the DB itself reject the cycle.
  withStore((store) => {
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'baseline', sessionId: 'sess-1',
    });
    assert.throws(
      () => store.db.prepare('UPDATE entries SET supersedes = ? WHERE id = ?').run(id, id),
      /CHECK constraint failed/i,
      'entries.supersedes must reject self-reference',
    );
    assert.throws(
      () => store.db
        .prepare('INSERT INTO entry_supersedes(new_id, old_id, created_at) VALUES (?, ?, ?)')
        .run(id, id, new Date().toISOString()),
      /CHECK constraint failed/i,
      'entry_supersedes must reject new_id == old_id',
    );
  });
});

test('quantizeToInt8 clamps and rounds Float32Array to Int8Array', () => {
  const f = new Float32Array([0, 0.5, -0.5, 1.0, -1.0, 2.0, -2.0]);
  const q = quantizeToInt8(f);
  assert.equal(q[0], 0);
  assert.equal(q[1], 64); // 0.5 * 127 = 63.5 → Math.round rounds half-up to 64
  assert.equal(q[2], -63); // -63.5 → -63 (Math.round rounds half-up, toward +inf)
  assert.equal(q[3], 127);
  assert.equal(q[4], -127);
  assert.equal(q[5], 127); // clamped
  assert.equal(q[6], -128); // clamped
});

test('writeEmbedding then semanticSearch finds the nearest neighbor', () => {
  withStore((store) => {
    const emb = fixedEmbedding(1);
    const id = store.insertEntry({
      tier: 'long',
      category: 'fact', scope: 'project',
      kind: 'fact',
      content: 'thing one',
      sessionId: 'sess-1',
      embedding: emb,
    });
    const hits = store.semanticSearch(emb, 5);
    assert.ok(hits.length >= 1);
    assert.equal(BigInt(hits[0].id), BigInt(id));
    // Same vector → distance ≈ 0 (cosine).
    assert.ok(hits[0].distance < 0.01, `distance=${hits[0].distance}`);
  });
});

test('semanticSearch ranks by cosine distance', () => {
  withStore((store) => {
    const a = fixedEmbedding(1);
    const b = fixedEmbedding(7);
    const idA = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a', sessionId: 'sess-1', embedding: a,
    });
    const idB = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'b', sessionId: 'sess-1', embedding: b,
    });
    const hits = store.semanticSearch(a, 5);
    assert.equal(BigInt(hits[0].id), BigInt(idA));
    // idB should be present too but with larger distance.
    const bRow = hits.find((h) => BigInt(h.id) === BigInt(idB));
    assert.ok(bRow);
    assert.ok(hits[0].distance < bRow.distance);
  });
});

test('semanticSearch excludes soft-archived rows', () => {
  withStore((store) => {
    const e = fixedEmbedding(2);
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'gone', sessionId: 'sess-1', embedding: e,
    });
    store.softArchive(id);
    const hits = store.semanticSearch(e, 5);
    assert.equal(hits.length, 0);
  });
});

test('writeEmbedding REPLACE replaces an existing vector for the same id', () => {
  withStore((store) => {
    const a = fixedEmbedding(1);
    const b = fixedEmbedding(7);
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'shifting', sessionId: 'sess-1', embedding: a,
    });
    // Replace with a different vector. Query for `b` — it should match this row.
    store.writeEmbedding(id, b);
    const hits = store.semanticSearch(b, 5);
    assert.equal(BigInt(hits[0].id), BigInt(id));
    assert.ok(hits[0].distance < 0.01);
  });
});

test('markSuperseded archives old and links new', () => {
  withStore((store) => {
    const oldId = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'old preference', sessionId: 'sess-1',
    });
    const newId = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'new preference', sessionId: 'sess-1',
    });
    store.markSuperseded(oldId, newId);
    assert.equal(store.fetch(oldId).active, 0);
    assert.equal(BigInt(store.fetch(newId).supersedes), BigInt(oldId));
  });
});

test('offsets get/set are per-session', () => {
  withStore((store) => {
    assert.equal(store.getOffset('s1'), 0);
    store.setOffset('s1', 1234);
    assert.equal(store.getOffset('s1'), 1234);
    store.setOffset('s1', 5678);
    assert.equal(store.getOffset('s1'), 5678);
    // Different session has its own row
    store.setOffset('s2', 99);
    assert.equal(store.getOffset('s1'), 5678);
    assert.equal(store.getOffset('s2'), 99);
  });
});

test('hasOffsetRow is false before any setOffset and true after (existence, not value)', () => {
  withStore((store) => {
    // The offset-init latch (lib/offset-init.js) depends on this distinction:
    // before any decision there is NO row; after a decision there is one,
    // regardless of its value.
    assert.equal(store.hasOffsetRow('sess-x'), false);
    store.setOffset('sess-x', 4242);
    assert.equal(store.hasOffsetRow('sess-x'), true);
    // Per-session, like get/setOffset — an unrelated session is still rowless.
    assert.equal(store.hasOffsetRow('sess-y'), false);
  });
});

test('hasOffsetRow is true for a deliberately value-0 row — the case getOffset cannot distinguish', () => {
  withStore((store) => {
    // The exact ambiguity the latch exists to resolve: a fresh
    // MINDWRIGHT_SEED_TRANSCRIPT session is left at offset 0 ON PURPOSE.
    // getOffset() returns 0 for BOTH "no row" and this deliberate value-0
    // row, so it cannot gate exactly-once; hasOffsetRow() must.
    assert.equal(store.hasOffsetRow('sess-0'), false);
    assert.equal(store.getOffset('sess-0'), 0); // no row → 0

    store.setOffset('sess-0', 0); // deliberate value-0 latch row

    assert.equal(store.getOffset('sess-0'), 0); // STILL 0 — indistinguishable via getOffset
    assert.equal(store.hasOffsetRow('sess-0'), true); // but the row now exists
  });
});

test('pendingEmbedSweep returns rows with no vec_index counterpart', () => {
  withStore((store) => {
    const e = fixedEmbedding(3);
    const withEmb = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'has emb',
      sessionId: 's', embedding: e,
    });
    const without = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'no emb',
      sessionId: 's',
    });
    const pending = store.pendingEmbedSweep(10);
    const ids = pending.map((r) => BigInt(r.id));
    assert.ok(ids.includes(BigInt(without)));
    assert.ok(!ids.includes(BigInt(withEmb)));
  });
});

test('countPendingEmbeds returns the true count, not capped by a sweep limit', () => {
  withStore((store) => {
    for (let i = 0; i < 5; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking', content: `unembedded ${i}`,
        sessionId: 's',
      });
    }
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'has emb',
      sessionId: 's', embedding: fixedEmbedding(99),
    });
    assert.equal(store.countPendingEmbeds(), 5);
    // Independent from the sweep LIMIT: a sweep capped at 2 still leaves
    // the count helper seeing all 5 pending rows.
    assert.equal(store.pendingEmbedSweep(2).length, 2);
    assert.equal(store.countPendingEmbeds(), 5);
  });
});

test('hardDeleteShortTerm removes rows and their vec_index counterparts', () => {
  withStore((store) => {
    const e = fixedEmbedding(1);
    const id = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'kill me',
      sessionId: 's', embedding: e,
    });
    store.hardDeleteShortTerm([id]);
    assert.equal(store.fetch(id), undefined);
    const hits = store.semanticSearch(e, 5);
    const stillThere = hits.find((h) => BigInt(h.id) === BigInt(id));
    assert.equal(stillThere, undefined);
  });
});

test('hardDeleteShortTerm chunks the IN-list so it stays below SQLITE_MAX_VARIABLE_NUMBER', () => {
  // Regression: previously emitted one DELETE with N placeholders where N
  // was the full id list. SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is
  // 999 on some builds — a project-scope drain of a long-running daemon
  // could exceed it and fail mid-transaction. Verify the chunked path
  // processes a list well past the conservative 500-row chunk size.
  withStore((store) => {
    const ids = [];
    for (let i = 0; i < 1200; i++) {
      ids.push(store.insertEntry({
        tier: 'short', kind: 'thinking', content: `row-${i}`, sessionId: 's',
      }));
    }
    assert.equal(store.countShortTermFor('s'), 1200);
    store.hardDeleteShortTerm(ids);
    assert.equal(store.countShortTermFor('s'), 0);
    // None of the deleted ids should still be in entries.
    const survivors = ids.filter((id) => store.fetch(id));
    assert.equal(survivors.length, 0, `${survivors.length} rows survived hardDelete`);
  });
});

test('countShortTermFor / countByTier reflect active rows only', () => {
  withStore((store) => {
    const a = store.insertEntry({ tier: 'short', kind: 'thinking', content: 'a', sessionId: 's1' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'b', sessionId: 's1' });
    store.insertEntry({ tier: 'long', category: 'fact', scope: 'project', kind: 'fact', content: 'c', sessionId: 's1' });
    assert.equal(store.countShortTermFor('s1'), 2);
    assert.deepEqual(store.countByTier(), { short: 2, long: 1 });
    store.softArchive(a);
    assert.equal(store.countShortTermFor('s1'), 1);
  });
});

test('countShortTermInOtherSessions excludes current session AND unbound bucket', () => {
  withStore((store) => {
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'self', sessionId: 's1' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'peer-a', sessionId: 's2' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'peer-b', sessionId: 's3' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'unbound', sessionId: 'mindwright-unbound' });
    // From s1's perspective, 2 peer rows. Unbound and self excluded.
    assert.equal(store.countShortTermInOtherSessions('s1'), 2);
    // From a non-existent session, all 3 bound rows count (still excludes unbound).
    assert.equal(store.countShortTermInOtherSessions('s-fresh'), 3);
  });
});

test('countUnboundActive / countUnboundShortTerm distinguish tier and respect active flag', () => {
  withStore((store) => {
    const a = store.insertEntry({ tier: 'short', kind: 'thinking', content: 'a', sessionId: 'mindwright-unbound' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'b', sessionId: 'mindwright-unbound' });
    store.insertEntry({ tier: 'long', category: 'fact', scope: 'project', kind: 'fact', content: 'long-unbound', sessionId: 'mindwright-unbound' });
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'self', sessionId: 's1' });
    assert.equal(store.countUnboundActive(), 3);
    assert.equal(store.countUnboundShortTerm(), 2);
    store.softArchive(a);
    assert.equal(store.countUnboundActive(), 2);
    assert.equal(store.countUnboundShortTerm(), 1);
  });
});

test('oldestUserPreference returns the earliest active long-term fact/user row or null', () => {
  withStore((store) => {
    assert.equal(store.oldestUserPreference(), null);
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'I prefer dark mode', sessionId: 's',
    });
    // Adjust created_at to an old date so the helper returns a deterministic value.
    store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'I prefer tabs over spaces', sessionId: 's',
    });
    // Project-scoped long-term row should be ignored.
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'project uses pnpm', sessionId: 's',
    });
    assert.equal(store.oldestUserPreference(), '2020-01-01T00:00:00.000Z');
    // Archive the oldest; helper should now return the other user row's created_at.
    store.softArchive(id);
    const next = store.oldestUserPreference();
    assert.ok(next && next !== '2020-01-01T00:00:00.000Z', `expected next-oldest user pref, got ${next}`);
  });
});

test('entities upsert + linkEntry creates many-to-many rows', () => {
  withStore((store) => {
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'edits to lib/store.js', sessionId: 's',
    });
    const e1 = store.upsertEntity('lib/store.js', 'file_path');
    const e2 = store.upsertEntity('lib/store.js', 'file_path'); // dup → same id
    assert.equal(e1, e2);
    store.linkEntry(id, e1);
    store.linkEntry(id, e1); // idempotent
    const rows = store.db.prepare('SELECT * FROM entry_entities WHERE entry_id = ?').all(id);
    assert.equal(rows.length, 1);
  });
});

test('roles get/set are per-session and dedup', () => {
  withStore((store) => {
    assert.deepEqual(store.getRoles('s1'), []);
    store.setRoles('s1', ['consolidator', 'planner', 'consolidator']);
    assert.deepEqual(store.getRoles('s1').sort(), ['consolidator', 'planner']);
  });
});

test('recordConsolidation + lastConsolidation', () => {
  withStore((store) => {
    assert.equal(store.lastConsolidation(), undefined);
    store.recordConsolidation({
      sessionId: 's', drainedCount: 10, drainedBytes: 1234, producedCount: 3,
    });
    const last = store.lastConsolidation();
    assert.equal(last.drained_count, 10);
    assert.equal(last.produced_count, 3);
  });
});

test('setPendingNudge / takePendingNudge round-trip and clear on take', () => {
  withStore((store) => {
    assert.equal(store.takePendingNudge('s1'), null);
    store.setPendingNudge('s1', 'first message');
    // Latest write wins.
    store.setPendingNudge('s1', 'second message');
    assert.equal(store.takePendingNudge('s1'), 'second message');
    // Second take is empty — drained atomically.
    assert.equal(store.takePendingNudge('s1'), null);
  });
});

test('pending nudges are per-session', () => {
  withStore((store) => {
    store.setPendingNudge('a', 'A');
    store.setPendingNudge('b', 'B');
    assert.equal(store.takePendingNudge('a'), 'A');
    assert.equal(store.takePendingNudge('b'), 'B');
    assert.equal(store.takePendingNudge('a'), null);
    assert.equal(store.takePendingNudge('b'), null);
  });
});

// correctness-3: a tool_use that never gets a paired tool_result (interrupted
// Bash, killed Agent subtask, MCP timeout) would otherwise leak permanently
// into the persisted toolMap. loadToolMap drops entries older than
// TOOL_MAP_TTL_MS, and clearToolMap removes the meta row entirely on clean
// session end / orphan sweep.
test('loadToolMap drops entries whose timestamp is older than TOOL_MAP_TTL_MS', () => {
  withStore((store) => {
    const sessionId = 'sess-ttl';
    const old = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h old
    const fresh = new Date(Date.now() - 1 * 60 * 1000).toISOString();   // 1m old
    const map = new Map([
      ['tu_stale', { name: 'Bash', input: { command: 'ls' }, source_ref: 's', timestamp: old }],
      ['tu_fresh', { name: 'Bash', input: { command: 'pwd' }, source_ref: 's', timestamp: fresh }],
    ]);
    store.saveToolMap(sessionId, map);

    const loaded = store.loadToolMap(sessionId);
    assert.equal(loaded.size, 1, 'stale entry must be evicted');
    assert.ok(loaded.has('tu_fresh'), 'fresh entry survives');
    assert.ok(!loaded.has('tu_stale'), 'stale entry is dropped');
  });
});

test('loadToolMap keeps legacy bare-string entries even though they lack a timestamp', () => {
  // The pre-pairing schema stored `id → name`. Such entries can still classify
  // a late inbox tool_result (the only data they need is the name), and they
  // pre-date the timestamp field — evicting them on a TTL miss would drop
  // valid legacy data instead of just leaked-this-session abandons.
  withStore((store) => {
    const sessionId = 'sess-legacy';
    // Write a raw legacy blob via _metaSet to bypass saveToolMap's object
    // normalization.
    store._metaSet(`tool_map:${sessionId}`, JSON.stringify({
      tu_legacy: 'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox',
    }));
    const loaded = store.loadToolMap(sessionId);
    assert.equal(loaded.size, 1);
    assert.equal(loaded.get('tu_legacy').name,
      'mcp__plugin_wrightward_wrightward-bus__wrightward_list_inbox');
  });
});

test('clearToolMap removes the persisted blob; subsequent load returns an empty map', () => {
  withStore((store) => {
    const sessionId = 'sess-clear';
    const map = new Map([
      ['tu1', { name: 'Bash', input: {}, source_ref: 's', timestamp: new Date().toISOString() }],
    ]);
    store.saveToolMap(sessionId, map);
    assert.equal(store.loadToolMap(sessionId).size, 1, 'precondition: blob persisted');

    store.clearToolMap(sessionId);
    assert.equal(store.loadToolMap(sessionId).size, 0, 'blob removed');
    // _metaGet returns null when the row is absent — distinct from "row with empty map".
    assert.equal(store._metaGet(`tool_map:${sessionId}`), null);
  });
});

test('clearToolMap is a no-op when no blob exists (no error, no side effect)', () => {
  withStore((store) => {
    assert.doesNotThrow(() => store.clearToolMap('sess-never-existed'));
  });
});

// best-practices-1: the meta upsert/point-read was copy-pasted ~18× with each
// site re-deriving its own timestamp. _metaSet/_metaGet now own that SQL +
// timestamp. The 18 routed public methods are covered by their own tests
// above (roles/nudge/tool_map/injected-ids/consolidator/daemon-down +
// migration idempotency — all still green); these two pin the helper contract
// the finding specifies.
test('_metaSet / _metaGet round-trip the RAW value, return null when absent, and upsert on conflict', () => {
  withStore((store) => {
    // Absent key → null (the "no row" signal callers branch on).
    assert.equal(store._metaGet('does-not-exist'), null);

    store._metaSet('k', 'v1');
    assert.equal(store._metaGet('k'), 'v1');

    // ON CONFLICT(key) DO UPDATE — second write overwrites, never throws a
    // PRIMARY KEY violation, never leaves a duplicate row.
    store._metaSet('k', 'v2');
    assert.equal(store._metaGet('k'), 'v2');
    const n = store.db.prepare('SELECT COUNT(*) AS c FROM meta WHERE key = ?').get('k').c;
    assert.equal(n, 1, 'upsert must keep exactly one row per key');

    // Raw string in, raw string out — decoding (JSON.parse/base64/shape) is
    // explicitly the caller's job, not the helper's.
    store._metaSet('j', '{"a":1}');
    assert.equal(store._metaGet('j'), '{"a":1}');
    assert.equal(typeof store._metaGet('j'), 'string');
  });
});

test('_metaSet stamps a valid ISO updated_at and refreshes it on overwrite', () => {
  withStore((store) => {
    store._metaSet('k', 'v1');
    const t1 = store.db.prepare('SELECT updated_at FROM meta WHERE key = ?').get('k').updated_at;
    assert.equal(typeof t1, 'string');
    assert.ok(Number.isFinite(Date.parse(t1)), `updated_at must be ISO-parseable, got ${t1}`);

    store._metaSet('k', 'v2');
    const t2 = store.db.prepare('SELECT updated_at FROM meta WHERE key = ?').get('k').updated_at;
    assert.ok(Number.isFinite(Date.parse(t2)));
    // Same-ms writes can tie; the centralized stamp must never go backwards.
    assert.ok(Date.parse(t2) >= Date.parse(t1), 'overwrite must not regress updated_at');
  });
});

// shortTermBytes() is the load-bearing measurement the seed-loop backpressure
// waiter (lib/seed-consolidate.js) polls to decide when short-term has drained
// back under SEED_BATCH_BUDGET_BYTES. Before these tests it was exercised only
// indirectly by an ASCII-content integration test, which would stay green for
// the exact two regressions that matter: dropping `CAST(content AS BLOB)` (→
// UTF-16 char count, undercounts multibyte corpora) or dropping the
// tier/active filter (→ counts long/archived rows, over-measures → premature
// consolidation). These pin the contract directly.

test('shortTermBytes() returns 0 on an empty store (COALESCE handles SUM over zero rows)', () => {
  withStore((store) => {
    assert.equal(store.shortTermBytes(), 0);
  });
});

test('shortTermBytes() counts only active short-tier rows — long-tier and soft-archived short rows are excluded', () => {
  withStore((store) => {
    store.insertEntry({ tier: 'short', kind: 'cli_prompt', content: 'abcde', sessionId: 's' }); // 5 bytes
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'fgh', sessionId: 's' });      // 3 bytes
    const baseline = store.shortTermBytes();

    assert.equal(baseline, 8, 'two ASCII short rows: 5 + 3 = 8 bytes');

    // A long-tier row must NOT count — counting distilled long-term content in
    // the SHORT-tier budget would over-measure and trip premature consolidation.
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a very long established fact that should be ignored entirely', sessionId: 's',
    });
    assert.equal(store.shortTermBytes(), baseline, 'long-tier content is excluded');

    // A soft-archived (active = 0) short row has been drained/forgotten and no
    // longer occupies the live budget — it must drop out of the measure.
    const archived = store.insertEntry({ tier: 'short', kind: 'thinking', content: 'XXXXXXXX', sessionId: 's' });
    assert.equal(store.shortTermBytes(), baseline + 8, 'a fresh active short row counts');
    store.softArchive(archived);
    assert.equal(store.shortTermBytes(), baseline, 'soft-archived short row drops out of the measure');
  });
});

test('shortTermBytes() measures UTF-8 byte length, not UTF-16 character count (the CAST AS BLOB invariant)', () => {
  withStore((store) => {
    // '日本語' is 3 JS string chars but 9 UTF-8 bytes; '🎉' is 2 UTF-16 code
    // units but 4 UTF-8 bytes. The seed loop accumulates Buffer.byteLength, so
    // shortTermBytes MUST match that — a LENGTH(content) (char-count)
    // regression would silently undercount multibyte transcripts and let
    // short-term balloon past the budget on non-ASCII corpora.
    const content = '日本語🎉';
    const utf8Bytes = Buffer.byteLength(content, 'utf8'); // 9 + 4 = 13

    assert.ok(utf8Bytes > content.length,
      'precondition: this content is multibyte (UTF-8 bytes exceed JS .length)');

    store.insertEntry({ tier: 'short', kind: 'cli_prompt', content, sessionId: 's' });

    assert.equal(store.shortTermBytes(), utf8Bytes,
      `must equal Buffer.byteLength (${utf8Bytes}), not the ${content.length}-char UTF-16 count`);
  });
});

// ---- pending-staging ------------------------------------------------------
// The pending_session_id column stages chunks captured during a live session
// without making them visible to retrieval, drain, or the cap. They become
// "real" short-term only at PreCompact / SessionEnd / SessionStart-orphan-
// sweep. The invariants below pin that contract directly against the store.

test('insertEntry rejects pendingSessionId for tier=long (consolidator output must never stage)', () => {
  withStore((store) => {
    // A long-tier row produced by the consolidator MUST be visible to retrieval
    // immediately; staging it silently would freeze the consolidator's output
    // behind a flush that may never fire (long-tier distillation is not tied
    // to PreCompact). The store rejects the misuse at the boundary so a bad
    // caller fails loud instead of leaking phantom long-term rows.
    assert.throws(
      () => store.insertEntry({
        tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
        content: 'should not stage', sessionId: 's',
        pendingSessionId: 's',
      }),
      /pendingSessionId is only valid for tier='short'/,
    );
  });
});

test('insertEntry with pendingSessionId persists the marker and pending counts but not real-short counts', () => {
  withStore((store) => {
    // Plant ONE pending row + ONE non-pending row under the same session. The
    // pending row carries the staging marker so countPendingFor sees it, but
    // countShortTermFor / countShortTermAllSessions filter it out — that's
    // what prevents pending chunks from tripping the cap.
    const pendingId = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'pending row',
      sessionId: 's-pending', pendingSessionId: 's-pending',
    });
    const realId = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'real row',
      sessionId: 's-pending',
    });
    const pendingRow = store.fetch(pendingId);
    const realRow = store.fetch(realId);
    assert.equal(pendingRow.pending_session_id, 's-pending');
    assert.equal(realRow.pending_session_id, null);

    assert.equal(store.countPendingFor('s-pending'), 1, 'pending count is the marker');
    assert.equal(store.countShortTermFor('s-pending'), 1, 'real short count excludes pending');
    assert.equal(store.countShortTermAllSessions(), 1, 'project-wide excludes pending too');
  });
});

test('promotePendingForSession flips the marker to NULL and returns the count moved', () => {
  withStore((store) => {
    for (let i = 0; i < 3; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking', content: `pending ${i}`,
        sessionId: 's-promote', pendingSessionId: 's-promote',
      });
    }
    // A peer's row stays pending — promote is scoped to the named session.
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'peer pending',
      sessionId: 's-peer', pendingSessionId: 's-peer',
    });

    assert.equal(store.countPendingFor('s-promote'), 3);
    const moved = store.promotePendingForSession('s-promote');
    assert.equal(moved, 3, 'returns the rows-moved count');
    assert.equal(store.countPendingFor('s-promote'), 0);
    assert.equal(store.countShortTermFor('s-promote'), 3, 'promoted rows now count as real');

    // Second call is a no-op (idempotent).
    assert.equal(store.promotePendingForSession('s-promote'), 0);

    // Peer's pending row is untouched — promote-pending must NEVER spill
    // outside the named session.
    assert.equal(store.countPendingFor('s-peer'), 1, 'peer pending must be untouched');
  });
});

test('promotePendingForSession with maxCreatedAt promotes only rows older than the cutoff (orphan-sweep race guard)', () => {
  // The orphan-sweep race: a session that was orphan-eligible at the SELECT
  // can resurrect via /resume and write FRESH pending rows before the
  // per-orphan UPDATE fires. Without a created_at bound on the UPDATE,
  // those fresh rows would be promoted prematurely, re-creating the
  // self-echo class the pending-staging design eliminates.
  withStore((store) => {
    const old = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'stale pending',
      sessionId: 's-race', pendingSessionId: 's-race',
    });
    const fresh = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'fresh pending',
      sessionId: 's-race', pendingSessionId: 's-race',
    });
    // Backdate the "old" row so the cutoff bites only it. created_at is set
    // by insertEntry internally; we UPDATE here to simulate >threshold age.
    const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(oldIso, old);

    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
    const moved = store.promotePendingForSession('s-race', { maxCreatedAt: cutoff });
    assert.equal(moved, 1, 'only the row older than the cutoff is promoted');

    // The stale row is now real short-term; the fresh row remains pending.
    assert.equal(store.fetch(old).pending_session_id, null);
    assert.equal(store.fetch(fresh).pending_session_id, 's-race');
    assert.equal(store.countPendingFor('s-race'), 1, 'fresh row stays pending');
  });
});

test('promotePendingForSession with no maxCreatedAt promotes ALL pending rows (PreCompact/SessionEnd own-session path unchanged)', () => {
  withStore((store) => {
    for (let i = 0; i < 3; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking', content: `row ${i}`,
        sessionId: 's-own', pendingSessionId: 's-own',
      });
    }
    // No cutoff → bulk promote, same as the original semantics.
    const moved = store.promotePendingForSession('s-own');
    assert.equal(moved, 3);
    assert.equal(store.countPendingFor('s-own'), 0);
  });
});

test('promotePendingForSession rejects an invalid maxCreatedAt (not a parseable ISO string)', () => {
  withStore((store) => {
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'x',
      sessionId: 's-bad', pendingSessionId: 's-bad',
    });
    assert.throws(
      () => store.promotePendingForSession('s-bad', { maxCreatedAt: 'not-a-date' }),
      /maxCreatedAt must be an ISO date string/,
    );
    // Underlying state untouched on the throw.
    assert.equal(store.countPendingFor('s-bad'), 1);
  });
});

test('promotePendingForSession leaves row id, content, embedding, and FTS intact (only the flag changes)', () => {
  withStore((store) => {
    const emb = fixedEmbedding(7);
    const id = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'staged chunk content',
      sessionId: 's-int', pendingSessionId: 's-int',
      embedding: emb,
    });
    // FTS5 sync trigger fires on INSERT regardless of pending; bm25Search is
    // gated by the JOIN's `pending_session_id IS NULL`. Pre-promotion BM25
    // returns nothing.
    assert.equal(store.bm25Search('staged chunk', 5).length, 0,
      'pre-promotion BM25 must not surface pending rows');

    store.promotePendingForSession('s-int');

    // Same id, same content, same embedding — only the flag changed.
    const row = store.fetch(id);
    assert.equal(row.content, 'staged chunk content');
    assert.equal(row.pending_session_id, null);
    const hits = store.bm25Search('staged chunk', 5);
    assert.ok(hits.some((h) => Number(h.id) === Number(id)),
      'post-promotion BM25 must surface the row that was pending');
    // vec_index row exists (embedding was persisted at insert time).
    const vec = store.db.prepare('SELECT 1 FROM vec_index WHERE rowid = ?').get(id);
    assert.ok(vec, 'embedding survives promotion (it was written at insert time)');
  });
});

test('semanticSearch / temporalSearch filter out pending rows (the self-echo class is structurally invisible)', () => {
  withStore((store) => {
    const emb = fixedEmbedding(3);
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'pending content',
      sessionId: 's-r', pendingSessionId: 's-r',
      embedding: emb,
    });
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'real content',
      sessionId: 's-r',
      embedding: emb,
    });
    // Semantic: vec MATCH returns both rows by distance, but the JOIN drops
    // the pending one.
    const sem = store.semanticSearch(emb, 10);
    const semIds = sem.map((r) => Number(r.id));
    assert.equal(semIds.length, 1, 'semantic should only see the real row');
    // Temporal: same filter.
    const tem = store.temporalSearch(10, 'short');
    assert.equal(tem.length, 1, 'temporal should only see the real row');
  });
});

test('orphanPendingSessions returns oldest-first and excludes the caller session', () => {
  withStore((store) => {
    const now = Date.now();
    const longAgo = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    const veryLongAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // Two orphan sessions and one live (caller) session, all with pending rows.
    const idA = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'orphan A',
      sessionId: 's-orphan-A', pendingSessionId: 's-orphan-A',
    });
    const idB = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'orphan B',
      sessionId: 's-orphan-B', pendingSessionId: 's-orphan-B',
    });
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'live caller',
      sessionId: 's-live', pendingSessionId: 's-live',
    });
    // Backdate so the orphans cross the threshold; the caller's row stays
    // recent.
    store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(veryLongAgo, idA);
    store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(longAgo, idB);

    const orphans = store.orphanPendingSessions({
      now,
      thresholdMs: 30 * 60 * 1000, // 30 min
      currentSessionId: 's-live',
    });
    const ids = orphans.map((o) => o.session_id);
    assert.deepEqual(ids, ['s-orphan-A', 's-orphan-B'],
      'oldest-first, caller excluded');
    assert.equal(orphans[0].n, 1, 'count per orphan session reported correctly');
  });
});

test('orphanPendingSessions: recent pending rows do not trigger', () => {
  withStore((store) => {
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'fresh pending',
      sessionId: 's-recent', pendingSessionId: 's-recent',
    });
    // created_at = now (default). Threshold is 30 min.
    const orphans = store.orphanPendingSessions({
      now: Date.now(),
      thresholdMs: 30 * 60 * 1000,
    });
    assert.deepEqual(orphans, [],
      'fresh pending rows must not register as orphaned');
  });
});

test('orphanPendingSessions rejects a missing or non-positive thresholdMs', () => {
  withStore((store) => {
    assert.throws(
      () => store.orphanPendingSessions({ now: Date.now() }),
      /thresholdMs must be a positive finite number/,
    );
    assert.throws(
      () => store.orphanPendingSessions({ now: Date.now(), thresholdMs: 0 }),
      /thresholdMs must be a positive finite number/,
    );
    assert.throws(
      () => store.orphanPendingSessions({ now: Date.now(), thresholdMs: -1 }),
      /thresholdMs must be a positive finite number/,
    );
  });
});
