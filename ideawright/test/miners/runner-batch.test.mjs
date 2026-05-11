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
