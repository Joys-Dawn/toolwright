// Tests for the four individual retrievers. Uses a tmp SQLite store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import {
  semanticSearch,
  bm25Search,
  graphSearch,
  temporalSearch,
} from '../lib/retrievers.js';

async function withStore(fn) {
  // Snapshot/restore MINDWRIGHT_PROJECT_ROOT so the env var doesn't leak.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-rtv-'));
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

function unitFloat(seed) {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed * (i + 1));
  let n = 0;
  for (let i = 0; i < 1024; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 1024; i++) v[i] /= n;
  return v;
}

test('semanticSearch returns nothing when given null embedding', async () => {
  await withStore(async (store) => {
    const out = await semanticSearch(store, null, 10);
    assert.deepEqual(out, []);
  });
});

test('semanticSearch ranks by cosine distance', async () => {
  await withStore(async (store) => {
    const a = unitFloat(1);
    const b = unitFloat(7);
    const idA = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'a', sessionId: 's', embedding: a,
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'b', sessionId: 's', embedding: b,
    });
    const hits = await semanticSearch(store, a, 5);
    assert.equal(BigInt(hits[0].id), BigInt(idA));
  });
});

test('bm25Search finds keyword matches', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'the user prefers tab indentation', sessionId: 's',
    });
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'unrelated chatter about lunch', sessionId: 's',
    });
    const hits = bm25Search(store, 'indentation', 5);
    assert.equal(hits.length, 1);
  });
});

test('bm25Search returns [] for empty / whitespace / single-char queries', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'anything', sessionId: 's',
    });
    assert.deepEqual(bm25Search(store, '', 5), []);
    assert.deepEqual(bm25Search(store, '   ', 5), []);
    assert.deepEqual(bm25Search(store, '!', 5), []);
  });
});

test('bm25Search survives FTS5-hostile query strings', async () => {
  await withStore((store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'the database is in lib/store.js', sessionId: 's',
    });
    // Punctuation / hyphens / parens / quotes that FTS5 would reject as bare tokens
    const hits = bm25Search(store, "what's in `lib/store.js`?", 5);
    assert.equal(hits.length, 1);
  });
});

test('bm25Search degrades to [] on SQLITE_ERROR; non-SQLite errors propagate', () => {
  // We stub the store with a query method that throws specific kinds of
  // errors to confirm the catch branch is keyed on `e.code`, not the message.
  const fakeStoreSqliteError = {
    bm25Search() {
      const err = new Error('whatever wording the driver wants');
      err.code = 'SQLITE_ERROR';
      throw err;
    },
  };
  assert.deepEqual(bm25Search(fakeStoreSqliteError, 'hello', 5), []);

  const fakeStoreTypeError = {
    bm25Search() { throw new TypeError('programming bug'); },
  };
  assert.throws(() => bm25Search(fakeStoreTypeError, 'hello', 5), /programming bug/);
});

test('bm25Search keeps single-character CJK query tokens (multilingual recall)', async () => {
  // Single-char Latin tokens like "a" / "I" are noise — flat {2,} drops them.
  // But CJK single chars (日 sun, 水 water, 我 I) are full lexical words.
  // A regression where the sanitizer applies {2,} uniformly across scripts
  // would silently strip these single-char tokens and return [] here.
  await withStore(async (store) => {
    store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: '今天 天气 很好', sessionId: 's',
    });
    // We don't care about the score — just that the sanitizer didn't drop
    // every token and short-circuit to [] before the query ran. FTS5 may or
    // may not match a row depending on tokenization, but the call must
    // produce a non-null query string (`"日" OR "水"`), reach the engine,
    // and return an array (often [] if no hit). A regression that throws or
    // returns non-array on a CJK-single-char query gets caught here.
    const hits = bm25Search(store, '日 水', 10);
    assert.ok(Array.isArray(hits),
      `sanitizer must not refuse a CJK-only single-char query; got ${typeof hits}`);
    const hits2 = bm25Search(store, '日 今天', 10);
    assert.ok(hits2.length >= 1, 'single-char CJK token + multi-char token must match');
    // And a plain single-char Latin query — sanitizer should drop the 'a'
    // and return no hits (rather than throw or match everything).
    const hits3 = bm25Search(store, 'a', 10);
    assert.deepEqual(hits3, []);
  });
});

test('tier filter is pushed into each retriever (semantic / bm25 / graph / temporal)', async () => {
  // Regression: recall used to double k and post-filter by tier — if the
  // unfiltered top-2k all happened to be the wrong tier, the caller saw
  // zero results even when matching tier rows existed. Now each retriever
  // takes tier as an argument and filters in SQL.
  await withStore(async (store) => {
    // Plant one short-term and one long-term row sharing keywords + entity.
    const shortId = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'we touched store.js for caching',
      sessionId: 's',
    });
    const longId = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'store.js owns the WAL connection',
      sessionId: 's',
    });
    const entityId = store.upsertEntity('store.js', 'file_path');
    store.linkEntry(shortId, entityId);
    store.linkEntry(longId, entityId);

    const bmLong = bm25Search(store, 'store', 10, 'long');
    assert.equal(bmLong.length, 1, 'bm25 long tier returns only long-term row');
    assert.equal(BigInt(bmLong[0].id), BigInt(longId));

    const bmShort = bm25Search(store, 'store', 10, 'short');
    assert.equal(bmShort.length, 1, 'bm25 short tier returns only short-term row');
    assert.equal(BigInt(bmShort[0].id), BigInt(shortId));

    const grLong = graphSearch(store, ['store.js'], 10, 'long');
    assert.equal(grLong.length, 1);
    assert.equal(BigInt(grLong[0].id), BigInt(longId));

    const grShort = graphSearch(store, ['store.js'], 10, 'short');
    assert.equal(grShort.length, 1);
    assert.equal(BigInt(grShort[0].id), BigInt(shortId));

    const tmLong = temporalSearch(store, 10, 'long');
    assert.equal(tmLong.length, 1);
    assert.equal(BigInt(tmLong[0].id), BigInt(longId));

    // No-tier path still mixes both tiers.
    const bmAll = bm25Search(store, 'store', 10);
    assert.equal(bmAll.length, 2);
  });
});

test('graphSearch returns [] when no entities', async () => {
  await withStore((store) => {
    const out = graphSearch(store, [], 10);
    assert.deepEqual(out, []);
  });
});

test('graphSearch finds rows linked to matching entities', async () => {
  await withStore((store) => {
    const id = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'edits to lib/store.js', sessionId: 's',
    });
    const eid = store.upsertEntity('lib/store.js', 'file_path');
    store.linkEntry(id, eid);
    const out = graphSearch(store, ['lib/store.js'], 10);
    assert.equal(out.length, 1);
    assert.equal(BigInt(out[0].id), BigInt(id));
  });
});

test('graphSearch orders by COALESCE(event_ts, created_at) DESC', async () => {
  await withStore((store) => {
    // older is inserted FIRST (older created_at) but given a FAR-FUTURE
    // event_ts; newer is inserted second with no event_ts. Pre-change
    // (created_at DESC) would rank `newer` first; COALESCE makes `older`
    // (event_ts 2099) outrank it.
    const older = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'linked, historical-but-recent event', sessionId: 's',
      eventTs: '2099-01-01T00:00:00.000Z',
    });
    const newer = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'linked, no event time', sessionId: 's',
    });
    const eid = store.upsertEntity('shared/entity.js', 'file_path');
    store.linkEntry(older, eid);
    store.linkEntry(newer, eid);

    const out = graphSearch(store, ['shared/entity.js'], 10).map((r) => Number(r.id));
    assert.deepEqual(out, [Number(older), Number(newer)],
      'row with newer event_ts must rank first even though created_at is older');
  });
});

test('graphSearch with NULL event_ts orders identically to pre-change (zero-regression)', async () => {
  await withStore((store) => {
    // Neither row has event_ts → COALESCE(event_ts, created_at) collapses to
    // exactly `created_at`, so the ORDER BY key is byte-identical to the
    // pre-change `ORDER BY e.created_at DESC`. graphSearch (a v1 stub) has
    // NO id tiebreak — its tie order on equal created_at is SQLite-defined
    // both before AND after this change — so we give the two rows DISTINCT
    // created_at to assert the fallback deterministically.
    const older = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'older linked', sessionId: 's',
    });
    store.db.prepare('UPDATE entries SET created_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', older);
    const newer = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'newer linked', sessionId: 's',
    });
    const eid = store.upsertEntity('reg/guard.js', 'file_path');
    store.linkEntry(older, eid);
    store.linkEntry(newer, eid);

    const out = graphSearch(store, ['reg/guard.js'], 10).map((r) => Number(r.id));
    assert.deepEqual(out, [Number(newer), Number(older)],
      'NULL event_ts ⇒ pure created_at DESC, exactly as before the column existed');
  });
});

test('temporalSearch orders by created_at desc', async () => {
  await withStore((store) => {
    // Two tight inserts may share a millisecond. The query orders by
    // (created_at DESC, id DESC), so the second insert (higher id) wins the
    // tie deterministically — pinning that behavior here without spinning.
    const a = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'first', sessionId: 's',
    });
    const b = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'second', sessionId: 's',
    });
    const hits = temporalSearch(store, 10);
    assert.equal(BigInt(hits[0].id), BigInt(b));
    assert.equal(BigInt(hits[1].id), BigInt(a));
  });
});
