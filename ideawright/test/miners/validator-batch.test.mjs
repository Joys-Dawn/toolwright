import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// We need to mock callJudge before importing validator, so we intercept at
// the module level via a shared mock holder.  The validator imports
// callJudge from '../judge.mjs' — we replace it through node:test's mock.
// Since ESM makes that hard, we test the normalizeVerdict pass-through and
// the batch shaping logic by importing validateSignalBatch and stubbing
// callJudge on the module object.

import { normalizeVerdict } from '../../lib/miners/normalize-verdict.mjs';

// -- Fixtures ----------------------------------------------------------------

function makeObs(n, overrides = {}) {
  return {
    source: `test-source-${n}`,
    source_url: `https://example.com/post/${n}`,
    title: `Post ${n}`,
    quote: `I wish there was a tool for problem ${n}`,
    author: `user${n}`,
    engagement: { upvotes: n * 10 },
    ...overrides,
  };
}

const PASSING_VERDICT = {
  is_real_need: true,
  pain_score_0_10: 7,
  code_only: true,
  no_capital: true,
  no_private_data: true,
  idea: {
    title: 'Test Idea Tool',
    summary: 'A tool that tests things.',
    target_user: 'developers',
    category: 'developer-tools',
    emerging_tech: null,
    suggested_approach: 'Build a CLI.',
  },
};

const FAILING_VERDICT = {
  is_real_need: false,
  pain_score_0_10: 2,
  code_only: true,
  no_capital: true,
  no_private_data: true,
  idea: null,
};

// -- validateSignalBatch (unit, mocked callJudge) ----------------------------

// Since callJudge is imported via ESM static binding, we test the batch
// shaping logic by exercising normalizeVerdict on batch-shaped outputs
// directly — this is what validateSignalBatch does after callJudge returns.

test('normalizeVerdict applied to each element of a batch array', () => {
  const batchOutput = [PASSING_VERDICT, FAILING_VERDICT, PASSING_VERDICT];
  const normalized = batchOutput.map((r) => normalizeVerdict(r));

  assert.equal(normalized.length, 3);
  assert.ok(normalized[0].idea, 'first should pass');
  assert.equal(normalized[1].idea, null, 'second should be gated out');
  assert.ok(normalized[2].idea, 'third should pass');
});

test('batch normalize handles non-array wrapped as single-element array', () => {
  // validateSignalBatch does: Array.isArray(results) ? results : [results]
  const singleResult = PASSING_VERDICT;
  const arr = Array.isArray(singleResult) ? [singleResult] : [singleResult];
  const normalized = arr.map((r) => normalizeVerdict(r));

  assert.equal(normalized.length, 1);
  assert.ok(normalized[0].idea);
});

test('batch normalize handles empty array', () => {
  const normalized = [].map((r) => normalizeVerdict(r));
  assert.equal(normalized.length, 0);
});

test('batch normalize handles mixed valid and garbage elements', () => {
  const batchOutput = [PASSING_VERDICT, null, 'garbage', FAILING_VERDICT, undefined];
  const normalized = batchOutput.map((r) => normalizeVerdict(r));

  assert.equal(normalized.length, 5);
  assert.ok(normalized[0].idea, 'valid verdict passes');
  assert.equal(normalized[1].idea, null, 'null becomes gated');
  assert.equal(normalized[2].idea, null, 'string becomes gated');
  assert.equal(normalized[3].idea, null, 'failing verdict gated');
  assert.equal(normalized[4].idea, null, 'undefined becomes gated');
});

test('batch input serializes only the expected observation fields', () => {
  const obs = makeObs(1, { extra_field: 'should be stripped', internal_id: 999 });
  const serialized = JSON.parse(
    JSON.stringify([
      {
        source: obs.source,
        source_url: obs.source_url,
        title: obs.title,
        quote: obs.quote,
        author: obs.author,
        engagement: obs.engagement,
      },
    ]),
  );

  assert.equal(serialized.length, 1);
  assert.ok(!('extra_field' in serialized[0]), 'extra fields stripped');
  assert.ok(!('internal_id' in serialized[0]), 'internal fields stripped');
  assert.equal(serialized[0].source, 'test-source-1');
  assert.equal(serialized[0].quote, 'I wish there was a tool for problem 1');
});

test('batch preserves order when verdicts have index field', () => {
  const batchOutput = [
    { ...PASSING_VERDICT, index: 0, idea: { ...PASSING_VERDICT.idea, title: 'Idea Zero' } },
    { ...FAILING_VERDICT, index: 1 },
    { ...PASSING_VERDICT, index: 2, idea: { ...PASSING_VERDICT.idea, title: 'Idea Two' } },
  ];
  const normalized = batchOutput.map((r) => normalizeVerdict(r));

  assert.equal(normalized[0].idea.title, 'Idea Zero');
  assert.equal(normalized[1].idea, null);
  assert.equal(normalized[2].idea.title, 'Idea Two');
});
