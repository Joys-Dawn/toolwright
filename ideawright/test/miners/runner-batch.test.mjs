import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, listByStatus } from '../../lib/db.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

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
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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

test('runMiners falls back to per-item when batch validator throws', async () => {
  const { db, dir } = freshDb();
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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
  const { runMiners } = await import('../../lib/miners/runner.mjs');

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
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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

test('runMiners respects batchSize chunking', async () => {
  const { db, dir } = freshDb();
  const { runMiners, MINERS } = await import('../../lib/miners/runner.mjs');

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
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'ideawright.json'),
      JSON.stringify({ sources: { reddit: { enabled: true } }, novelty: { batch_size: 2 } }),
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
