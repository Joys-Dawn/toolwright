import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankAll, computeComposite, avgPainScore } from '../../lib/orchestration/ranker.mjs';
import { openDb, insertIdea, updateNovelty, updateFeasibility, computeId, listByStatus } from '../../lib/db.mjs';

function setupDb() {
  return openDb({ filename: ':memory:' });
}

function makeGatedIdea(db, { title, target_user, pain_scores, novelty_score, feasibility_score }) {
  const id = computeId(title, target_user);
  insertIdea(db, {
    title,
    target_user,
    pain_evidence: pain_scores.map(s => ({ source_url: 'https://example.com/x', quote: 'q', pain_score_0_10: s })),
    source_urls: ['https://example.com/x'],
  });
  updateNovelty(db, id, {
    score_0_100: novelty_score,
    verdict: 'novel',
    competitors: [],
    queries_run: ['x'],
    verified_at: new Date().toISOString(),
  }, 'verified');
  updateFeasibility(db, id, {
    code_only: true, no_capital: true, no_private_data: true,
    impl_sketch: 'x', effort: 'days',
    score_0_100: feasibility_score, verdict: 'go',
  }, null, 'gated');
  return id;
}

test('avgPainScore averages numeric scores, defaults to 5 when none', () => {
  assert.equal(avgPainScore({ pain_evidence: [{ pain_score_0_10: 4 }, { pain_score_0_10: 8 }] }), 6);
  assert.equal(avgPainScore({ pain_evidence: [] }), 5);
  assert.equal(avgPainScore({}), 5);
});

test('computeComposite applies weights correctly', () => {
  const idea = {
    pain_evidence: [{ pain_score_0_10: 8 }],
    novelty: { score_0_100: 80 },
    feasibility: { score_0_100: 70 },
  };
  const w = { pain: 0.3, novelty: 0.4, feasibility: 0.3 };
  const r = computeComposite(idea, w);
  assert.ok(Math.abs(r - 0.77) < 1e-9, `expected ~0.77, got ${r}`);
});

test('rankAll writes composite_rank for all gated ideas', () => {
  const db = setupDb();
  const id1 = makeGatedIdea(db, { title: 'A', target_user: 'devs', pain_scores: [9], novelty_score: 90, feasibility_score: 80 });
  const id2 = makeGatedIdea(db, { title: 'B', target_user: 'designers', pain_scores: [3], novelty_score: 40, feasibility_score: 50 });

  const result = rankAll({ db, weights: { pain: 0.3, novelty: 0.4, feasibility: 0.3 } });
  assert.equal(result.ranked, 2);

  const gated = listByStatus(db, 'gated');
  const byId = Object.fromEntries(gated.map(i => [i.id, i.composite_rank]));
  assert.ok(byId[id1] > byId[id2], 'higher-scoring idea should outrank lower');
  assert.ok(Math.abs(byId[id1] - (0.3 * 0.9 + 0.4 * 0.9 + 0.3 * 0.8)) < 1e-9);
});

test('rankAll skips non-gated ideas', () => {
  const db = setupDb();
  const id = computeId('X', 'u');
  insertIdea(db, { title: 'X', target_user: 'u', pain_evidence: [{ source_url: 'https://e.com', quote: 'q', pain_score_0_10: 5 }] });

  rankAll({ db, weights: {} });

  const row = db.prepare('SELECT composite_rank FROM ideas WHERE id = ?').get(id);
  assert.equal(row.composite_rank, null);
});
