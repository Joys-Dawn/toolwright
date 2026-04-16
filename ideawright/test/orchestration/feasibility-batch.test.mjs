import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertIdea, updateNovelty, listByStatus } from '../../lib/db.mjs';
import { gateFeasibility } from '../../lib/orchestration/feasibility.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// -- Helpers -----------------------------------------------------------------

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ideawright-feas-test-'));
  const db = openDb({ filename: join(dir, 'test.db') });
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

function seedVerifiedIdea(db, n) {
  const id = `test-idea-${n}`;
  insertIdea(db, {
    id,
    title: `Idea ${n}`,
    summary: `Summary ${n}`,
    target_user: `user-${n}`,
    category: 'developer-tools',
    pain_evidence: [{ source_url: `https://example.com/${n}`, quote: `pain ${n}`, pain_score_0_10: 7 }],
    source_urls: [`https://example.com/${n}`],
    source_module: 'test',
  });
  updateNovelty(db, id, { score_0_100: 90, verdict: 'novel', competitors: [] }, 'verified');
  return id;
}

const GO_RESULT = {
  code_only: true,
  no_capital: true,
  no_private_data: true,
  impl_sketch: 'Build a CLI tool.',
  effort: 'days',
  score_0_100: 80,
  verdict: 'go',
};

const REJECT_RESULT = {
  code_only: false,
  no_capital: true,
  no_private_data: true,
  impl_sketch: 'Needs hardware.',
  effort: 'weeks',
  score_0_100: 20,
  verdict: 'reject',
};

// -- Tests -------------------------------------------------------------------

test('gateFeasibility processes ideas in batches via a single judge call', async () => {
  const { db, dir } = freshDb();
  seedVerifiedIdea(db, 1);
  seedVerifiedIdea(db, 2);
  seedVerifiedIdea(db, 3);

  let judgeCalls = 0;
  const fakeJudge = async () => {
    judgeCalls++;
    return [GO_RESULT, REJECT_RESULT, GO_RESULT];
  };

  const result = await gateFeasibility({ db, config: {}, _judge: fakeJudge });

  assert.equal(judgeCalls, 1, 'should make one batch judge call for 3 ideas');
  assert.equal(result.gated, 2);
  assert.equal(result.archived, 1);
  assert.equal(result.total, 3);

  cleanup({ db, dir });
});

test('gateFeasibility falls back to per-item on batch failure', async () => {
  const { db, dir } = freshDb();
  seedVerifiedIdea(db, 1);
  seedVerifiedIdea(db, 2);

  let judgeCalls = 0;
  const failThenSucceed = async () => {
    judgeCalls++;
    if (judgeCalls === 1) throw new Error('batch failed');
    return GO_RESULT;
  };

  const result = await gateFeasibility({ db, config: {}, _judge: failThenSucceed });

  // 1 batch call (fails) + 2 per-item fallbacks = 3 total
  assert.equal(judgeCalls, 3, 'should fall back to per-item after batch failure');
  assert.equal(result.gated, 2);
  assert.equal(result.total, 2);

  cleanup({ db, dir });
});

test('gateFeasibility respects batch_size from config', async () => {
  const { db, dir } = freshDb();
  for (let i = 1; i <= 5; i++) seedVerifiedIdea(db, i);

  let judgeCalls = 0;
  const countingJudge = async () => {
    judgeCalls++;
    return [GO_RESULT, GO_RESULT];
  };

  await gateFeasibility({
    db,
    config: { novelty: { batch_size: 2 } },
    _judge: countingJudge,
  });

  assert.equal(judgeCalls, 3, 'should make 3 batch calls for 5 ideas at batchSize=2');

  cleanup({ db, dir });
});

test('gateFeasibility handles null result from judge gracefully', async () => {
  const { db, dir } = freshDb();
  seedVerifiedIdea(db, 1);
  seedVerifiedIdea(db, 2);

  const fakeJudge = async () => [GO_RESULT, null];

  const result = await gateFeasibility({ db, config: {}, _judge: fakeJudge });

  assert.equal(result.gated, 1);
  assert.equal(result.errored, 1);
  assert.equal(result.total, 2);

  cleanup({ db, dir });
});

test('gateFeasibility with zero verified ideas returns zero counts', async () => {
  const { db, dir } = freshDb();

  let judgeCalls = 0;
  const fakeJudge = async () => { judgeCalls++; return []; };

  const result = await gateFeasibility({ db, config: {}, _judge: fakeJudge });

  assert.equal(judgeCalls, 0, 'should not call judge with no ideas');
  assert.equal(result.total, 0);
  assert.equal(result.gated, 0);

  cleanup({ db, dir });
});

test('gateFeasibility archives when gate fails even if verdict is go', async () => {
  const { db, dir } = freshDb();
  seedVerifiedIdea(db, 1);

  // verdict=go but code_only=false → gate fails → archived
  const fakeJudge = async () => [{ ...GO_RESULT, code_only: false }];

  const result = await gateFeasibility({ db, config: {}, _judge: fakeJudge });

  assert.equal(result.archived, 1);
  assert.equal(result.gated, 0);
  const archived = listByStatus(db, 'archived');
  assert.equal(archived.length, 1);

  cleanup({ db, dir });
});
