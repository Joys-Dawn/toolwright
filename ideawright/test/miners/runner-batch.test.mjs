import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, listByStatus, getSourceCursor } from '../../lib/db.mjs';
import { runMiners, MINERS } from '../../lib/miners/runner.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

// -- Helpers -----------------------------------------------------------------

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ideawright-test-'));
  const db = openDb({ filename: join(dir, 'test.db') });
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeObs(n) {
  return {
    source: 'test',
    source_url: `https://example.com/${n}`,
    title: `Post ${n}`,
    quote: `I wish there was a tool for problem ${n}`,
    author: `user${n}`,
    engagement: { upvotes: n * 10 },
  };
}

function passingVerdict(n) {
  return {
    is_real_need: true,
    pain_score_0_10: 7,
    code_only: true,
    no_capital: true,
    no_private_data: true,
    idea: {
      title: `Novel Idea ${n}`,
      summary: `Solves problem ${n}.`,
      target_user: `segment-${n}`,
      category: 'developer-tools',
      emerging_tech: null,
      suggested_approach: 'Build it.',
    },
  };
}

const FAILING_VERDICT = {
  is_real_need: false,
  pain_score_0_10: 2,
  code_only: true,
  no_capital: true,
  no_private_data: true,
  idea: null,
};

// Fake batch validator that returns passing verdicts for each observation
function fakeBatchPass(observations) {
  return observations.map((_, i) => passingVerdict(i + 1));
}

// Fake batch validator that always throws (forces per-item fallback)
function fakeBatchFail() {
  throw new Error('batch call failed');
}

// Fake batch validator that returns all-failing verdicts
function fakeBatchReject(observations) {
  return observations.map(() => FAILING_VERDICT);
}

// -- Tests -------------------------------------------------------------------

test('runMiners inserts validated ideas via batch path', async () => {
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3)],
      cursors: {},
    }),
    validator: async (o) => passingVerdict(1),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchPass,
    });

    assert.equal(summary.observations, 3);
    const ideas = listByStatus(db, 'new');
    assert.equal(ideas.length, 3, 'all 3 unique ideas should be inserted');
    assert.equal(ideas[0].status, 'new');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners persists raw observations BEFORE validation runs', async () => {
  // Recovery scenario: if validation walls (5-hour usage cap → all per-item
  // calls return errors), the raw observation must still be in the DB so we
  // can re-validate later instead of losing it forever.
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3)],
      cursors: { foo: 'bar' },
    }),
    validator: async () => { throw new Error('claude exited 1: usage limit'); },
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchFail,
    });

    const rows = db.prepare('SELECT * FROM raw_observations ORDER BY id').all();
    assert.equal(rows.length, 3, 'all 3 raw observations must be persisted');
    assert.ok(rows.every((r) => r.last_error && r.last_error.includes('usage limit')),
      'each row should have last_error stamped');
    assert.ok(rows.every((r) => r.validated_at === null && r.idea_id === null),
      'validated_at must remain null when validation fails');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners stamps raw observations with idea_id on successful validation', async () => {
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2)],
      cursors: {},
    }),
    validator: async () => passingVerdict(1),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchPass,
    });

    const rows = db.prepare('SELECT * FROM raw_observations ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.validated_at !== null), 'validated_at must be set');
    assert.ok(rows.every((r) => r.idea_id !== null), 'idea_id must point to inserted idea');
    assert.ok(rows.every((r) => r.last_error === null));
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners does NOT advance source cursor when per-item errors occurred', async () => {
  // If validation walls mid-source, we want the next run to re-mine the same
  // signals once the upstream cap resets. Pinning the cursor in place is how
  // we achieve that. The heartbeat (last_run_at) IS still recorded though —
  // operators need to see the source was attempted even when it errored.
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2)],
      cursors: { advanced: 'past-the-wall' },
    }),
    validator: async () => { throw new Error('claude exited 1'); },
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchFail,
    });

    const cursor = getSourceCursor(db, 'reddit');
    assert.ok(cursor, 'cursor row must exist (heartbeat) even when errors occurred');
    assert.ok(cursor.last_run_at, 'last_run_at heartbeat must be recorded');
    assert.equal(cursor.notes, null, 'cursor notes (advancement state) must NOT be set when errored');
    assert.equal(cursor.last_seen_id, null, 'cursor last_seen_id must NOT be advanced when errored');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners advances source cursor when validation completes without errors', async () => {
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1)],
      cursors: { my_key: 'my_value' },
    }),
    validator: async () => passingVerdict(1),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchPass,
    });

    const cursor = getSourceCursor(db, 'reddit');
    assert.ok(cursor, 'cursor row must be created on a clean run');
    const notes = JSON.parse(cursor.notes);
    assert.equal(notes.my_key, 'my_value', 'cursor notes must be persisted');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners surfaces per-item validate errors instead of silently treating them as "no idea"', async () => {
  // Regression test: when batch fails AND per-item validate also fails for every
  // observation (e.g., 5-hour usage cap on claude -p), the runner used to swallow
  // the errors and return validated=0 with no log output — making rate-limit walls
  // indistinguishable from "no real signals". This pins the fix:
  //   1. each per-item failure must produce a warn log
  //   2. the source summary must include errored=N reflecting failed calls
  const { db, dir } = freshDb();
  const warnings = [];
  const warnLogger = { ...silentLogger, warn: (msg) => warnings.push(msg) };

  const failingPerItem = async () => { throw new Error('claude exited 1: usage limit reached'); };
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3)],
      cursors: {},
    }),
    validator: failingPerItem,
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: warnLogger,
      _batchValidate: fakeBatchFail,
    });

    assert.equal(summary.sources.reddit.errored, 3, 'every per-item failure must be counted');
    assert.equal(summary.validated, 0);
    const perItemWarns = warnings.filter((w) => w.includes('[validate] per-item'));
    assert.equal(perItemWarns.length, 3, 'each per-item failure must log a warning');
    assert.ok(perItemWarns.every((w) => w.includes('usage limit')), 'underlying error message must be preserved');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners falls back to per-item when batch validator throws', async () => {
  const { db, dir } = freshDb();
  const warnings = [];
  const warnLogger = { ...silentLogger, warn: (msg) => warnings.push(msg) };

  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2)],
      cursors: {},
    }),
    validator: async (o) => passingVerdict(1),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: warnLogger,
      _batchValidate: fakeBatchFail,
    });

    assert.ok(warnings.some((w) => w.includes('falling back')), 'should log fallback warning');
    const ideas = listByStatus(db, 'new');
    assert.ok(ideas.length > 0, 'fallback per-item should still insert ideas');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners handles miner failure gracefully', async () => {
  const { db, dir } = freshDb();
  const crashMiner = {
    mine: async () => { throw new Error('network timeout'); },
  };

  const original = MINERS.reddit;
  MINERS.reddit = crashMiner;

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
    });

    assert.ok(summary.sources.reddit.error, 'should record the error');
    assert.equal(summary.inserted, 0);
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners skips unknown miner ids without crashing', async () => {
  const { db, dir } = freshDb();
  const warnings = [];
  const warnLogger = { ...silentLogger, warn: (msg) => warnings.push(msg) };

  const summary = await runMiners({
    db,
    repoRoot: dir,
    sources: ['nonexistent_source'],
    logger: warnLogger,
  });

  assert.equal(summary.observations, 0);
  assert.equal(summary.inserted, 0);
  assert.ok(warnings.some((w) => w.includes('nonexistent_source')), 'should warn about missing miner');
  cleanup({ db, dir });
});

test('runMiners deduplicates ideas with same title and target_user', async () => {
  const { db, dir } = freshDb();
// Both observations produce the same verdict (same title + target_user → same id)
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2)],
      cursors: {},
    }),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  // Batch always returns the same idea for both — same id hash
  const sameIdea = passingVerdict(1);
  const batchSameTitleValidator = (obs) => obs.map(() => sameIdea);

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: batchSameTitleValidator,
    });

    assert.equal(summary.validated, 2, 'both should validate');
    const ideas = listByStatus(db, 'new');
    assert.equal(ideas.length, 1, 'duplicate should be deduped by INSERT OR IGNORE');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners with empty observations produces zero inserts', async () => {
  const { db, dir } = freshDb();
  const emptyMiner = {
    mine: async () => ({ observations: [], cursors: {} }),
  };

  const original = MINERS.reddit;
  MINERS.reddit = emptyMiner;

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
    });

    assert.equal(summary.observations, 0);
    assert.equal(summary.validated, 0);
    assert.equal(summary.inserted, 0);
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners gates rejected ideas from insertion', async () => {
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3)],
      cursors: {},
    }),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchReject,
    });

    assert.equal(summary.observations, 3);
    const ideas = listByStatus(db, 'new');
    assert.equal(ideas.length, 0, 'rejected ideas should not be inserted');
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners skips re-validating raw observations already judged in a prior run', async () => {
  // Recovery scenario: a prior run judged 3 obs successfully, then errored on
  // a 4th and pinned the cursor. The next run re-mines all 4. The 3 already-
  // validated rows must NOT trigger another LLM call — only the failed one.
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3), makeObs(4)],
      cursors: {},
    }),
    validator: async () => passingVerdict(1),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    // First run: validate 3 of 4 successfully via batch (4th errored manually)
    let firstRunCalls = 0;
    const firstRunBatch = (obs) => {
      firstRunCalls++;
      // Return verdicts for ALL obs in the batch — first run validates everything
      return obs.map((_, i) => passingVerdict(i + 1));
    };
    await runMiners({
      db, repoRoot: dir, sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: firstRunBatch,
    });
    assert.equal(firstRunCalls, 1, 'first run hits the validator once');

    const afterFirst = db.prepare('SELECT COUNT(*) AS n FROM raw_observations WHERE validated_at IS NOT NULL').get();
    assert.equal(afterFirst.n, 4, 'all 4 should be validated after first run');

    // Second run: same observations come in. Validator must NOT be called.
    let secondRunCalls = 0;
    const secondRunBatch = (obs) => {
      secondRunCalls++;
      return obs.map((_, i) => passingVerdict(i + 1));
    };
    const secondSummary = await runMiners({
      db, repoRoot: dir, sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: secondRunBatch,
    });
    assert.equal(secondRunCalls, 0, 'second run must not re-validate already-judged rows');
    assert.equal(secondSummary.sources.reddit.skipped_already_validated, 4, 'summary must report skip count');
    assert.equal(secondSummary.sources.reddit.validated, 0);
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

test('runMiners respects batchSize chunking', async () => {
  const { db, dir } = freshDb();
  let batchCallCount = 0;
  const countingBatch = (obs) => {
    batchCallCount++;
    return obs.map((_, i) => passingVerdict(batchCallCount * 100 + i));
  };

  // 5 observations with batchSize 2 → 3 batch calls (2+2+1)
  const fakeMiner = {
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3), makeObs(4), makeObs(5)],
      cursors: {},
    }),
  };

  const original = MINERS.reddit;
  MINERS.reddit = fakeMiner;

  try {
    // Config with batch_size=2
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'ideawright.json'),
      JSON.stringify({ sources: { reddit: { enabled: true } }, validate: { batch_size: 2 } }),
    );

    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: countingBatch,
    });

    assert.equal(batchCallCount, 3, 'should make 3 batch calls for 5 items at batchSize=2');
    assert.equal(summary.observations, 5);
  } finally {
    MINERS.reddit = original;
    cleanup({ db, dir });
  }
});

// -- Concurrency / fan-out regression tests ----------------------------------
//
// These pin the parallel-runner + shared-limiter behavior. They use the
// deferred-promise / peak-counter pattern from test/novelty/limiter.test.mjs
// (NO setTimeout / wall-clock timing) so scheduling is fully deterministic:
// kick off runMiners WITHOUT awaiting it, drain microtask turns until the
// system is wedged against the gate, assert the invariant, then release.

// Manually-controlled promise the test settles to drive scheduling.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Yield enough microtask turns for runMiners' fan-out + limiter to reach
// steady state against a blocking gate.
async function drainMicrotasks(n = 60) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Save/restore an arbitrary set of MINERS entries.
function swapMiners(map) {
  const saved = {};
  for (const [id, impl] of Object.entries(map)) {
    saved[id] = MINERS[id];
    MINERS[id] = impl;
  }
  return () => { for (const id of Object.keys(map)) MINERS[id] = saved[id]; };
}

test('runMiners fans miners out concurrently (mine() calls overlap, not serialized)', async () => {
  // 3 miners whose mine() blocks on a shared gate. If the runner were still
  // the old sequential `for (const id of activeIds)` loop, only ONE mine()
  // could be in-flight at a time (peak=1). Parallel fan-out → peak=3.
  const { db, dir } = freshDb();
  let active = 0;
  let peak = 0;
  const gate = deferred();
  const blockingMiner = () => ({
    mine: async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return { observations: [], cursors: {} };
    },
  });

  const restore = swapMiners({
    reddit: blockingMiner(),
    hn: blockingMiner(),
    github: blockingMiner(),
  });

  try {
    const p = runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit', 'hn', 'github'],
      logger: silentLogger,
    });

    await drainMicrotasks();
    assert.equal(peak, 3, 'all 3 miners must be in-flight simultaneously (parallel fan-out)');

    gate.resolve();
    const summary = await p;
    assert.equal(active, 0, 'every miner must drain');
    assert.ok(summary.sources.reddit && summary.sources.hn && summary.sources.github);
  } finally {
    restore();
    cleanup({ db, dir });
  }
});

test('runMiners bounds concurrent batch-validate calls across all sources to validate.concurrency', async () => {
  // 5 sources each fire ONE batch-validate call. They run concurrently via
  // the parallel fan-out, but every batch call schedules through the single
  // shared limiter, so no more than validate.concurrency may be in-flight at
  // once. concurrency is supplied via config.validate.concurrency (proves the
  // config knob is wired, mirroring the validate.batch_size test above).
  const { db, dir } = freshDb();
  let active = 0;
  let peak = 0;
  const release = deferred();
  const recordingBatch = async (observations) => {
    active++;
    peak = Math.max(peak, active);
    await release.promise;
    active--;
    return observations.map((_, i) => passingVerdict(i + 1));
  };

  const fakeMiner = () => ({
    mine: async () => ({ observations: [makeObs(1), makeObs(2)], cursors: {} }),
  });
  const restore = swapMiners({
    reddit: fakeMiner(),
    hn: fakeMiner(),
    github: fakeMiner(),
    arxiv: fakeMiner(),
    biorxiv: fakeMiner(),
  });

  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'ideawright.json'),
      JSON.stringify({ validate: { concurrency: 2 } }),
    );

    const p = runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit', 'hn', 'github', 'arxiv', 'biorxiv'],
      logger: silentLogger,
      _batchValidate: recordingBatch,
    });

    await drainMicrotasks();
    assert.ok(peak <= 2, `concurrent batch calls must be capped at 2, saw ${peak}`);
    assert.equal(peak, 2, 'the cap must actually be reached (5 sources, 2 slots)');

    release.resolve();
    const summary = await p;
    assert.ok(peak <= 2, 'cap must hold through drain');
    assert.equal(summary.observations, 10, 'all 5 sources validated (2 obs each)');
  } finally {
    restore();
    cleanup({ db, dir });
  }
});

test('runMiners bounds concurrent PER-ITEM fallback validate calls across all sources', async () => {
  // The Critical fix this pins: when the batch validator throws (the 5-hour
  // usage-cap condition this whole change targets), each source falls back to
  // per-item `validate`. With 5 sources × 3 obs that is 15 `claude`-spawning
  // per-item calls. If only the batch call were limiter-wrapped, all 15 would
  // run at once (each source Promise.all's its 3, ×5 sources). Wrapping the
  // per-item call in the SAME shared limiter caps it at validate.concurrency.
  const { db, dir } = freshDb();
  let active = 0;
  let peak = 0;
  const release = deferred();
  const recordingValidate = async () => {
    active++;
    peak = Math.max(peak, active);
    await release.promise;
    active--;
    return passingVerdict(1);
  };
  const throwingBatch = () => { throw new Error('batch down: usage cap'); };

  const fallbackMiner = () => ({
    mine: async () => ({
      observations: [makeObs(1), makeObs(2), makeObs(3)],
      cursors: {},
    }),
    validator: recordingValidate,
  });
  const restore = swapMiners({
    reddit: fallbackMiner(),
    hn: fallbackMiner(),
    github: fallbackMiner(),
    arxiv: fallbackMiner(),
    biorxiv: fallbackMiner(),
  });

  try {
    const p = runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit', 'hn', 'github', 'arxiv', 'biorxiv'],
      validationConcurrency: 2,
      logger: silentLogger,
      _batchValidate: throwingBatch,
    });

    await drainMicrotasks(120);
    assert.ok(peak <= 2, `per-item fallback must be capped at 2 across all sources, saw ${peak}`);
    assert.equal(peak, 2, 'the cap must actually be reached (15 per-item calls, 2 slots)');

    release.resolve();
    const summary = await p;
    assert.ok(peak <= 2, 'cap must hold through drain');
    // Fallback still produces ideas — bounding must not drop work.
    assert.equal(summary.validated, 15, 'all 15 per-item validations succeed');
    assert.equal(summary.sources.reddit.errored, 0, 'no per-item errors');
    const ideas = listByStatus(db, 'new');
    assert.ok(ideas.length >= 1, 'bounded fallback still inserts ideas');
  } finally {
    restore();
    cleanup({ db, dir });
  }
});

test('runMiners isolates a failing miner: others still validate+insert (allSettled)', async () => {
  // One miner throwing must not reject the whole batch nor block the others.
  const { db, dir } = freshDb();
  const restore = swapMiners({
    reddit: { mine: async () => { throw new Error('boom'); } },
    hn: { mine: async () => ({ observations: [makeObs(1), makeObs(2)], cursors: {} }) },
    github: { mine: async () => ({ observations: [makeObs(3), makeObs(4)], cursors: {} }) },
  });

  try {
    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit', 'hn', 'github'],
      logger: silentLogger,
      _batchValidate: fakeBatchPass,
    });

    assert.deepEqual(summary.sources.reddit, { error: 'boom' }, 'thrower yields only an error entry');
    assert.equal(summary.sources.hn.error, undefined, 'hn must be unaffected');
    assert.equal(summary.sources.hn.validated, 2);
    assert.equal(summary.sources.github.validated, 2);
    assert.equal(summary.observations, 4, 'only the two healthy sources contribute observations');
    const ideas = listByStatus(db, 'new');
    assert.ok(ideas.length > 0, 'healthy sources still insert ideas despite the failure');
  } finally {
    restore();
    cleanup({ db, dir });
  }
});

test('runMiners surfaces a pre-mine (getSourceCursor) failure via the allSettled rejected branch', async () => {
  // runSource() catches miner.mine() errors itself, so the ONLY way it can
  // reject (hitting runMiners' settled.status==='rejected' branch) is a throw
  // BEFORE its try block — e.g. getSourceCursor(). A db whose prepare() throws
  // makes getSourceCursor throw synchronously; this proves that branch turns a
  // rejected runSource into summary.sources[id]={error} and never calls mine().
  const dir = mkdtempSync(join(tmpdir(), 'ideawright-test-'));
  const errors = [];
  const errLogger = { ...silentLogger, error: (m) => errors.push(m) };
  let mineCalled = false;
  const restore = swapMiners({
    reddit: { mine: async () => { mineCalled = true; return { observations: [], cursors: {} }; } },
  });
  const brokenDb = { prepare() { throw new Error('db unavailable'); } };

  try {
    const summary = await runMiners({
      db: brokenDb,
      repoRoot: dir,
      sources: ['reddit'],
      logger: errLogger,
    });

    assert.deepEqual(summary.sources.reddit, { error: 'db unavailable' },
      'rejected runSource is surfaced as an {error} entry');
    assert.equal(mineCalled, false,
      'failure occurred before miner.mine — proving the rejected branch, not the in-try catch');
    assert.ok(
      errors.some((m) => m.includes('[scan:reddit] miner failed') && m.includes('db unavailable')),
      'rejected branch logs the failure',
    );
    assert.equal(summary.observations, 0);
    assert.equal(summary.inserted, 0);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runMiners with config validate.concurrency=0 does not hang (falls back to a working limiter)', async () => {
  // Regression for audit correctness-2: 0 is not nullish, so the old
  // `?? validationConcurrency` passed 0 straight to makeLimiter, whose pump
  // never enters (`active < 0` is false) → every `await limit(...)` hangs
  // forever. The fix coerces any non-finite / < 1 config value back to the
  // param default. Pre-fix this test wedges (suite stalls on the hang);
  // post-fix it completes and validation still runs under the fallback.
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({ observations: [makeObs(1), makeObs(2)], cursors: {} }),
  };
  const restore = swapMiners({ reddit: fakeMiner });

  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'ideawright.json'),
      JSON.stringify({ validate: { concurrency: 0 } }),
    );

    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: fakeBatchPass,
    });

    assert.equal(summary.observations, 2, 'run completed instead of hanging');
    const ideas = listByStatus(db, 'new');
    assert.equal(ideas.length, 2, 'validation still ran (limiter pumped) under the fallback concurrency');
  } finally {
    restore();
    cleanup({ db, dir });
  }
});

test('runMiners with config validate.batch_size=0 does not hang (falls back to default batching)', async () => {
  // Regression for audit correctness-3: 0 is not nullish, so the old `?? 20`
  // fed 0 into `for (i=0; i<pending.length; i += batchSize)`, which never
  // advances → infinite loop, silent hang. The fix coerces any non-finite /
  // < 1 value back to the default 20. Pre-fix this wedges; post-fix it
  // completes with the 3 obs validated in a single fallback-sized batch.
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({ observations: [makeObs(1), makeObs(2), makeObs(3)], cursors: {} }),
  };
  const restore = swapMiners({ reddit: fakeMiner });

  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'ideawright.json'),
      JSON.stringify({ validate: { batch_size: 0 } }),
    );

    let batchCalls = 0;
    const countingBatch = (obs) => { batchCalls++; return obs.map((_, i) => passingVerdict(i + 1)); };

    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: silentLogger,
      _batchValidate: countingBatch,
    });

    assert.equal(summary.observations, 3, 'run completed instead of hanging');
    assert.equal(batchCalls, 1, '3 obs fit in one batch under the fallback batch_size (20)');
    const ideas = listByStatus(db, 'new');
    assert.equal(ideas.length, 3, 'all observations validated and inserted');
  } finally {
    restore();
    cleanup({ db, dir });
  }
});

test('runMiners warns (does not silently swallow) when .claude/ideawright.json is malformed, then falls back to defaults', async () => {
  // Regression for audit best-practices-4: loadConfig caught the JSON parse
  // error with an unused `err` and no log, so a single typo in the
  // user-authored config silently reverted EVERY tunable (rate limits,
  // validate.concurrency/batch_size, enabled sources, model) to defaults with
  // zero operator feedback. The fix threads the logger in and warns loudly
  // before falling back. Assert both facets of that contract: the failure is
  // surfaced AND the run still completes on defaults.
  const { db, dir } = freshDb();
  const fakeMiner = {
    mine: async () => ({ observations: [makeObs(1), makeObs(2)], cursors: {} }),
  };
  const restore = swapMiners({ reddit: fakeMiner });
  const warnings = [];
  const capturingLogger = { ...silentLogger, warn: (m) => warnings.push(m) };

  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'ideawright.json'), '{ "validate": { not valid json');

    const summary = await runMiners({
      db,
      repoRoot: dir,
      sources: ['reddit'],
      logger: capturingLogger,
      _batchValidate: fakeBatchPass,
    });

    const warned = warnings.find((m) => m.includes('ideawright.json'));
    assert.ok(
      warned,
      `the malformed-config parse failure must be surfaced, not swallowed; saw ${JSON.stringify(warnings)}`,
    );
    assert.ok(warned.includes('using defaults'), 'the warning tells the operator defaults are in effect');
    assert.equal(summary.observations, 2, 'run still completes on default config (graceful fallback preserved)');
    assert.equal(listByStatus(db, 'new').length, 2, 'observations validated+inserted under defaults');
  } finally {
    restore();
    cleanup({ db, dir });
  }
});
