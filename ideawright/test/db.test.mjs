import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  normalize,
  computeId,
  insertIdea,
  insertRawObservation,
  markRawObservationValidated,
  markRawObservationError,
  setSourceCursor,
  touchSourceLastRun,
  getSourceCursor,
  listByStatus,
  listTopRanked,
  rowToIdea,
  updateFeasibility,
} from '../lib/db.mjs';

// In-memory DB per test — fast, isolated, no disk. Mirrors the convention
// in test/orchestration/digest.test.mjs and test/novelty/runner.test.mjs.
function freshDb() {
  return openDb({ filename: ':memory:' });
}

function stateLogRows(db, ideaId) {
  return db
    .prepare('SELECT * FROM state_log WHERE idea_id = ? ORDER BY id')
    .all(ideaId);
}

// -- normalize ---------------------------------------------------------------

test('normalize returns empty string for null and undefined', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('normalize lowercases, trims, and collapses internal whitespace runs', () => {
  assert.equal(normalize('  Hello   World  '), 'hello world');
  assert.equal(normalize('A\tB\nC'), 'a b c');
});

test('normalize string-coerces non-string input', () => {
  assert.equal(normalize(123), '123');
});

// -- computeId (dedup key) ---------------------------------------------------

test('computeId is a stable 64-char hex SHA-256 of the normalized basis', () => {
  const id = computeId('Title', 'user');
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, computeId('Title', 'user'), 'same input → same id');
});

test('computeId collapses inputs that normalize identically to the same id', () => {
  // Dedup contract: "Foo  Bar" / " foo bar " / "FOO BAR" are the same idea.
  assert.equal(computeId('Foo  Bar', 'Indie Devs'), computeId(' foo bar ', 'indie devs'));
});

test('computeId distinguishes ideas whose title OR target_user differ', () => {
  assert.notEqual(computeId('A', 'u'), computeId('B', 'u'));
  assert.notEqual(computeId('A', 'u1'), computeId('A', 'u2'));
  // The `|` separator prevents title/target_user boundary collisions.
  assert.notEqual(computeId('ab', 'c'), computeId('a', 'bc'));
});

// -- insertIdea --------------------------------------------------------------

test('insertIdea inserts a new row, returns inserted=true, and logs one transition', () => {
  const db = freshDb();
  try {
    const { id, inserted } = insertIdea(db, {
      title: 'Build A Thing',
      target_user: 'devs',
      summary: 's',
      source_module: 'reddit',
      note: 'seed',
    });

    assert.equal(inserted, true);
    assert.equal(id, computeId('Build A Thing', 'devs'));
    const log = stateLogRows(db, id);
    assert.equal(log.length, 1);
    assert.equal(log[0].from_status, null);
    assert.equal(log[0].to_status, 'new');
    assert.equal(log[0].actor, 'reddit', 'source_module becomes the transition actor');
    assert.equal(log[0].note, 'seed');
  } finally { db.close(); }
});

test('insertIdea is idempotent: a duplicate id is ignored and logs NO second transition', () => {
  const db = freshDb();
  try {
    const first = insertIdea(db, { title: 'Dup', target_user: 'u' });
    const second = insertIdea(db, { title: 'Dup', target_user: 'u', summary: 'changed' });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false, 'OR IGNORE → no overwrite, inserted=false');
    assert.equal(second.id, first.id);
    const ideaRows = db.prepare('SELECT COUNT(*) AS n FROM ideas').get();
    assert.equal(Number(ideaRows.n), 1, 'still exactly one idea row');
    assert.equal(stateLogRows(db, first.id).length, 1,
      'logTransition must fire only on the inserting call');
  } finally { db.close(); }
});

test('insertIdea honors an explicit id and defaults actor to "miner"', () => {
  const db = freshDb();
  try {
    const { id } = insertIdea(db, { id: 'custom-id', title: 'T', target_user: 'u' });
    assert.equal(id, 'custom-id');
    assert.equal(stateLogRows(db, 'custom-id')[0].actor, 'miner');
  } finally { db.close(); }
});

test('insertIdea serializes pain_evidence and source_urls as JSON', () => {
  const db = freshDb();
  try {
    const { id } = insertIdea(db, {
      title: 'T', target_user: 'u',
      pain_evidence: [{ quote: 'q' }],
      source_urls: ['https://e.com'],
    });
    const row = db.prepare('SELECT pain_evidence, source_urls FROM ideas WHERE id = ?').get(id);
    assert.deepEqual(JSON.parse(row.pain_evidence), [{ quote: 'q' }]);
    assert.deepEqual(JSON.parse(row.source_urls), ['https://e.com']);
  } finally { db.close(); }
});

// -- insertRawObservation ----------------------------------------------------

test('insertRawObservation creates one row and reports validated=false', () => {
  const db = freshDb();
  try {
    const r = insertRawObservation(db, {
      source: 'reddit', source_url: 'https://r.com/1', title: 't', quote: 'q',
    });
    assert.equal(r.validated, false);
    assert.ok(Number.isInteger(r.id));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM raw_observations').get().n), 1);
  } finally { db.close(); }
});

test('insertRawObservation is idempotent on (source, source_url): re-mining is a no-op', () => {
  const db = freshDb();
  try {
    const a = insertRawObservation(db, { source: 'hn', source_url: 'https://h.com/x' });
    const b = insertRawObservation(db, { source: 'hn', source_url: 'https://h.com/x', title: 'new title' });

    assert.equal(b.id, a.id, 're-mine returns the existing row id');
    assert.equal(b.validated, false);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM raw_observations').get().n), 1,
      'no duplicate row inserted');
  } finally { db.close(); }
});

test('insertRawObservation dedupes a null-source_url signal (expression unique index normalizes NULL → "")', () => {
  // SQLite treats every NULL as distinct in a plain UNIQUE constraint, so the
  // inline UNIQUE(source, source_url) alone would let a url-less observation
  // re-insert (and re-judge) every run. The `idx_raw_obs_source_url` unique
  // index on (source, COALESCE(source_url,'')) closes that: a second url-less
  // insert for the same source now conflicts, INSERT OR IGNORE is ignored, and
  // the `source_url IS ?` recovery SELECT returns the existing row.
  const db = freshDb();
  try {
    const a = insertRawObservation(db, { source: 'github' }); // source_url omitted → null
    const b = insertRawObservation(db, { source: 'github' });

    assert.equal(b.id, a.id, 'a re-mined null-url signal returns the existing row');
    assert.equal(b.validated, false);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM raw_observations').get().n), 1,
      'no duplicate row inserted for the url-less signal');
  } finally { db.close(); }
});

test('insertRawObservation reports validated=true for a re-mined null-source_url signal once judged', () => {
  // Proves the recovery SELECT`s `source_url IS NULL` branch — now reachable
  // because the expression index makes the second null-url insert conflict.
  const db = freshDb();
  try {
    const first = insertRawObservation(db, { source: 'hn' }); // null source_url
    markRawObservationValidated(db, first.id, 'idea-null-url');

    const again = insertRawObservation(db, { source: 'hn' });
    assert.equal(again.id, first.id);
    assert.equal(again.validated, true, 'caller can skip re-judging the already-judged url-less signal');
  } finally { db.close(); }
});

test('insertRawObservation reports validated=true once the row has been judged', () => {
  const db = freshDb();
  try {
    const first = insertRawObservation(db, { source: 'reddit', source_url: 'https://r.com/2' });
    markRawObservationValidated(db, first.id, 'idea-abc');

    const second = insertRawObservation(db, { source: 'reddit', source_url: 'https://r.com/2' });
    assert.equal(second.validated, true, 'caller can skip re-judging an already-validated signal');
  } finally { db.close(); }
});

test('insertRawObservation returns null for a malformed observation with no source', () => {
  // source is NOT NULL; OR IGNORE skips the row (changes=0), and the recovery
  // SELECT `WHERE source = ?` can never match NULL → null, not a fabricated id.
  const db = freshDb();
  try {
    const r = insertRawObservation(db, { source: null, source_url: 'https://x.com' });
    assert.equal(r, null);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM raw_observations').get().n), 0);
  } finally { db.close(); }
});

// -- markRawObservationValidated / markRawObservationError -------------------

test('markRawObservationValidated stamps validated_at + idea_id and clears last_error', () => {
  const db = freshDb();
  try {
    const { id } = insertRawObservation(db, { source: 's', source_url: 'u' });
    markRawObservationError(db, id, 'a prior failure');
    markRawObservationValidated(db, id, 'idea-1');

    const row = db.prepare('SELECT * FROM raw_observations WHERE id = ?').get(id);
    assert.notEqual(row.validated_at, null);
    assert.equal(row.idea_id, 'idea-1');
    assert.equal(row.last_error, null, 'a successful validation clears the prior error');
  } finally { db.close(); }
});

test('markRawObservationValidated is a no-op for a falsy rowid', () => {
  const db = freshDb();
  try {
    const { id } = insertRawObservation(db, { source: 's', source_url: 'u' });
    assert.doesNotThrow(() => markRawObservationValidated(db, 0, 'idea-x'));
    assert.doesNotThrow(() => markRawObservationValidated(db, null, 'idea-x'));
    assert.equal(db.prepare('SELECT validated_at FROM raw_observations WHERE id = ?').get(id).validated_at,
      null, 'no row was touched');
  } finally { db.close(); }
});

test('markRawObservationError caps last_error at 1000 characters', () => {
  const db = freshDb();
  try {
    const { id } = insertRawObservation(db, { source: 's', source_url: 'u' });
    markRawObservationError(db, id, 'x'.repeat(1500));
    const { last_error } = db.prepare('SELECT last_error FROM raw_observations WHERE id = ?').get(id);
    assert.equal(last_error.length, 1000);
  } finally { db.close(); }
});

test('markRawObservationError coerces a nullish message to an empty string', () => {
  const db = freshDb();
  try {
    const { id } = insertRawObservation(db, { source: 's', source_url: 'u' });
    markRawObservationError(db, id, null);
    assert.equal(db.prepare('SELECT last_error FROM raw_observations WHERE id = ?').get(id).last_error, '');
  } finally { db.close(); }
});

test('markRawObservationError is a no-op for a falsy rowid', () => {
  const db = freshDb();
  try {
    const { id } = insertRawObservation(db, { source: 's', source_url: 'u' });
    assert.doesNotThrow(() => markRawObservationError(db, 0, 'boom'));
    assert.equal(db.prepare('SELECT last_error FROM raw_observations WHERE id = ?').get(id).last_error,
      null, 'no row was touched');
  } finally { db.close(); }
});

// -- setSourceCursor vs touchSourceLastRun -----------------------------------

test('setSourceCursor upserts last_seen_id and notes, overwriting on conflict', () => {
  const db = freshDb();
  try {
    setSourceCursor(db, 'reddit', { last_seen_id: 't3_a', notes: 'first' });
    let cur = getSourceCursor(db, 'reddit');
    assert.equal(cur.last_seen_id, 't3_a');
    assert.equal(cur.notes, 'first');

    setSourceCursor(db, 'reddit', { last_seen_id: 't3_b', notes: 'second' });
    cur = getSourceCursor(db, 'reddit');
    assert.equal(cur.last_seen_id, 't3_b', 'conflict overwrites last_seen_id');
    assert.equal(cur.notes, 'second', 'conflict overwrites notes');
  } finally { db.close(); }
});

test('touchSourceLastRun heartbeats last_run_at WITHOUT clobbering an advanced cursor', () => {
  // The error-path contract: a source that errored after advancing must keep
  // its last_seen_id/notes so the next run resumes, while still recording the
  // attempt timestamp.
  const db = freshDb();
  try {
    setSourceCursor(db, 'hn', { last_seen_id: 'progress-99', notes: 'advanced' });
    touchSourceLastRun(db, 'hn');

    const cur = getSourceCursor(db, 'hn');
    assert.equal(cur.last_seen_id, 'progress-99', 'heartbeat must NOT clobber last_seen_id');
    assert.equal(cur.notes, 'advanced', 'heartbeat must NOT clobber notes');
    assert.ok(cur.last_run_at, 'heartbeat records the attempt timestamp');
  } finally { db.close(); }
});

test('touchSourceLastRun creates a bare heartbeat row for a never-seen source', () => {
  const db = freshDb();
  try {
    touchSourceLastRun(db, 'arxiv');
    const cur = getSourceCursor(db, 'arxiv');
    assert.ok(cur, 'a row is created');
    assert.equal(cur.last_seen_id, null);
    assert.equal(cur.notes, null);
    assert.ok(cur.last_run_at);
  } finally { db.close(); }
});

test('getSourceCursor returns null for an unknown source', () => {
  const db = freshDb();
  try {
    assert.equal(getSourceCursor(db, 'nope'), null);
  } finally { db.close(); }
});

// -- rowToIdea (pure JSON-safety) --------------------------------------------

test('rowToIdea defaults null/missing pain_evidence and source_urls to empty arrays', () => {
  const idea = rowToIdea({ id: 'x', title: 't', pain_evidence: null });
  assert.deepEqual(idea.pain_evidence, []);
  assert.deepEqual(idea.source_urls, [], 'a missing column also defaults to []');
});

test('rowToIdea parses populated JSON columns and nulls absent novelty/feasibility', () => {
  const idea = rowToIdea({
    id: 'x', title: 't',
    pain_evidence: '[{"quote":"q"}]',
    source_urls: '["https://e.com"]',
    novelty: '{"verdict":"novel"}',
    feasibility: null,
  });
  assert.deepEqual(idea.pain_evidence, [{ quote: 'q' }]);
  assert.deepEqual(idea.source_urls, ['https://e.com']);
  assert.deepEqual(idea.novelty, { verdict: 'novel' });
  assert.equal(idea.feasibility, null);
  assert.equal(idea.id, 'x', 'all other row columns are passed through unchanged');
});

// -- listByStatus ------------------------------------------------------------

test('listByStatus filters by status and orders by updated_at DESC', () => {
  const db = freshDb();
  try {
    const { id: older } = insertIdea(db, { title: 'Older', target_user: 'u' });
    const { id: newer } = insertIdea(db, { title: 'Newer', target_user: 'u' });
    // Pin distinct timestamps so DESC ordering is deterministic (datetime('now')
    // is second-precision and both insert within the same second otherwise).
    db.prepare("UPDATE ideas SET updated_at = '2026-04-01 00:00:00' WHERE id = ?").run(older);
    db.prepare("UPDATE ideas SET updated_at = '2026-04-02 00:00:00' WHERE id = ?").run(newer);

    const rows = listByStatus(db, 'new');
    assert.deepEqual(rows.map((r) => r.title), ['Newer', 'Older']);
  } finally { db.close(); }
});

test('listByStatus caps results at the supplied limit', () => {
  const db = freshDb();
  try {
    for (let i = 0; i < 5; i++) insertIdea(db, { title: `T${i}`, target_user: 'u' });
    assert.equal(listByStatus(db, 'new', 2).length, 2);
  } finally { db.close(); }
});

test('listByStatus excludes rows in other statuses', () => {
  const db = freshDb();
  try {
    insertIdea(db, { title: 'a-new', target_user: 'u' });
    const { id } = insertIdea(db, { title: 'a-gated', target_user: 'u' });
    updateFeasibility(db, id, { verdict: 'go' }, 0.5, 'gated');

    const news = listByStatus(db, 'new');
    assert.equal(news.length, 1);
    assert.equal(news[0].title, 'a-new');
  } finally { db.close(); }
});

// -- listTopRanked -----------------------------------------------------------

test('listTopRanked returns only promoted rows with a non-null composite_rank, ranked DESC', () => {
  const db = freshDb();
  try {
    const promotedHigh = insertIdea(db, { title: 'High', target_user: 'u' }).id;
    const promotedLow = insertIdea(db, { title: 'Low', target_user: 'u' }).id;
    const promotedNullRank = insertIdea(db, { title: 'NoRank', target_user: 'u' }).id;
    const gated = insertIdea(db, { title: 'Gated', target_user: 'u' }).id;

    updateFeasibility(db, promotedHigh, { verdict: 'go' }, 0.9, 'promoted');
    updateFeasibility(db, promotedLow, { verdict: 'go' }, 0.4, 'promoted');
    updateFeasibility(db, promotedNullRank, { verdict: 'go' }, null, 'promoted');
    updateFeasibility(db, gated, { verdict: 'go' }, 0.99, 'gated');

    const top = listTopRanked(db);
    assert.deepEqual(top.map((r) => r.title), ['High', 'Low'],
      'promoted+ranked only, highest composite_rank first');
  } finally { db.close(); }
});

test('listTopRanked caps results at the supplied limit', () => {
  const db = freshDb();
  try {
    for (let i = 0; i < 4; i++) {
      const { id } = insertIdea(db, { title: `P${i}`, target_user: 'u' });
      updateFeasibility(db, id, { verdict: 'go' }, 0.1 * (i + 1), 'promoted');
    }
    assert.equal(listTopRanked(db, 2).length, 2);
  } finally { db.close(); }
});
