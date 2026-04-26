import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, formatMarkdown } from '../../lib/orchestration/digest.mjs';
import { openDb, insertIdea, updateNovelty, updateFeasibility, computeId } from '../../lib/db.mjs';

function setupDb() {
  return openDb({ filename: ':memory:' });
}

test('formatMarkdown emits placeholder when list is empty', () => {
  const md = formatMarkdown([]);
  assert.match(md, /No promoted ideas yet/);
});

test('formatMarkdown renders core fields per idea', () => {
  const md = formatMarkdown([{
    title: 'Test Tool',
    target_user: 'indie hackers',
    category: 'dev-tools',
    summary: 'A tool for testing.',
    composite_rank: 0.812,
    novelty: { verdict: 'novel', score_0_100: 85, competitors: [] },
    feasibility: { verdict: 'go', effort: 'days', impl_sketch: 'build it' },
    pain_evidence: [{ source_url: 'https://reddit.com/x', quote: 'I wish there was a thing' }],
  }]);
  assert.match(md, /Test Tool/);
  assert.match(md, /rank 0\.812/);
  assert.match(md, /indie hackers/);
  assert.match(md, /novelty:.*novel.*85\/100/);
  assert.match(md, /feasibility:.*go.*days/);
  assert.match(md, /build it/);
  assert.match(md, /I wish there was a thing/);
  assert.match(md, /reddit\.com\/x/);
});

test('buildDigest promotes gated ideas and caps at topN', () => {
  const db = setupDb();
  for (let i = 0; i < 5; i++) {
    const id = computeId(`Idea ${i}`, 'users');
    insertIdea(db, {
      title: `Idea ${i}`, target_user: 'users',
      pain_evidence: [{ source_url: 'https://e.com', quote: 'q', pain_score_0_10: 5 }],
    });
    updateNovelty(db, id, { score_0_100: 50, verdict: 'novel', competitors: [], queries_run: [], verified_at: '2026-04-15T00:00:00Z' }, 'verified');
    updateFeasibility(db, id, { code_only: true, no_capital: true, no_private_data: true, impl_sketch: 's', effort: 'days', score_0_100: 60, verdict: 'go' }, 0.5 + i * 0.05, 'gated');
  }

  const result = buildDigest({ db, topN: 3 });
  assert.equal(result.count, 3);
  assert.equal(result.promoted, 3);

  const promoted = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE status = 'promoted'`).get().n;
  assert.equal(Number(promoted), 3);
  assert.match(result.markdown, /Idea 4/);
  assert.match(result.markdown, /Idea 3/);
  assert.match(result.markdown, /Idea 2/);
});

test('buildDigest with sinceDate excludes ideas updated before that date', () => {
  const db = setupDb();
  // Backdate two old promoted ideas to yesterday.
  for (const t of ['Old A', 'Old B']) {
    const id = computeId(t, 'u');
    insertIdea(db, { title: t, target_user: 'u', pain_evidence: [{ source_url: 'https://e.com', quote: 'q', pain_score_0_10: 5 }] });
    updateNovelty(db, id, { score_0_100: 90, verdict: 'novel', competitors: [], queries_run: [], verified_at: '2026-04-24T00:00:00Z' }, 'verified');
    updateFeasibility(db, id, { code_only: true, no_capital: true, no_private_data: true, impl_sketch: 's', effort: 'days', score_0_100: 80, verdict: 'go' }, 0.9, 'promoted');
  }
  db.prepare(`UPDATE ideas SET updated_at = '2026-04-24 12:00:00' WHERE title LIKE 'Old %'`).run();

  // Two fresh gated ideas updated today.
  for (const t of ['New A', 'New B']) {
    const id = computeId(t, 'u');
    insertIdea(db, { title: t, target_user: 'u', pain_evidence: [{ source_url: 'https://e.com', quote: 'q', pain_score_0_10: 5 }] });
    updateNovelty(db, id, { score_0_100: 50, verdict: 'novel', competitors: [], queries_run: [], verified_at: '2026-04-25T00:00:00Z' }, 'verified');
    updateFeasibility(db, id, { code_only: true, no_capital: true, no_private_data: true, impl_sketch: 's', effort: 'days', score_0_100: 60, verdict: 'go' }, 0.5, 'gated');
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  const result = buildDigest({ db, topN: 10, sinceDate: todayUtc });
  assert.equal(result.count, 2, 'only today-updated ideas should appear');
  assert.match(result.markdown, /New A/);
  assert.match(result.markdown, /New B/);
  assert.doesNotMatch(result.markdown, /Old A/);
  assert.doesNotMatch(result.markdown, /Old B/);
});
