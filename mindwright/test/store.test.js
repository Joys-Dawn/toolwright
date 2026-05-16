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
