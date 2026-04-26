import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignalBatch } from '../../lib/miners/validator.mjs';

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

function fakeJudge(returns) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return typeof returns === 'function' ? returns(opts) : returns;
  };
  fn.calls = calls;
  return fn;
}

// -- Tests -------------------------------------------------------------------

test('validateSignalBatch issues one judge call and normalizes each result', async () => {
  const judge = fakeJudge([PASSING_VERDICT, FAILING_VERDICT, PASSING_VERDICT]);

  const results = await validateSignalBatch(
    [makeObs(1), makeObs(2), makeObs(3)],
    { _callJudge: judge },
  );

  assert.equal(judge.calls.length, 1, 'exactly one judge call for the whole batch');
  assert.equal(results.length, 3);
  assert.ok(results[0].idea, 'passing verdict keeps idea');
  assert.equal(results[1].idea, null, 'failing verdict gates out idea');
  assert.ok(results[2].idea);
});

test('validateSignalBatch returns empty array without calling judge for empty input', async () => {
  const judge = fakeJudge([]);

  const results = await validateSignalBatch([], { _callJudge: judge });

  assert.deepEqual(results, []);
  assert.equal(judge.calls.length, 0, 'must not call judge with no observations');
});

test('validateSignalBatch wraps non-array judge response into a single-element result', async () => {
  const judge = fakeJudge(PASSING_VERDICT);

  const results = await validateSignalBatch([makeObs(1)], { _callJudge: judge });

  assert.equal(results.length, 1);
  assert.ok(results[0].idea);
});

test('validateSignalBatch normalizes garbage entries (null/string/undefined) without throwing', async () => {
  const judge = fakeJudge([PASSING_VERDICT, null, 'garbage', FAILING_VERDICT, undefined]);

  const results = await validateSignalBatch(
    [makeObs(1), makeObs(2), makeObs(3), makeObs(4), makeObs(5)],
    { _callJudge: judge },
  );

  assert.equal(results.length, 5);
  assert.ok(results[0].idea);
  assert.equal(results[1].idea, null, 'null normalized to gated');
  assert.equal(results[2].idea, null, 'string normalized to gated');
  assert.equal(results[3].idea, null);
  assert.equal(results[4].idea, null, 'undefined normalized to gated');
});

test('validateSignalBatch sends only the documented observation fields to the judge', async () => {
  const judge = fakeJudge([PASSING_VERDICT]);
  const obs = makeObs(1, { extra_field: 'should be stripped', internal_id: 999 });

  await validateSignalBatch([obs], { _callJudge: judge });

  const sent = JSON.parse(judge.calls[0].user);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), [
    'author', 'engagement', 'quote', 'source', 'source_url', 'title',
  ]);
  assert.ok(!('extra_field' in sent[0]));
  assert.ok(!('internal_id' in sent[0]));
});

test('validateSignalBatch passes model option through to the judge', async () => {
  const judge = fakeJudge([PASSING_VERDICT]);

  await validateSignalBatch([makeObs(1)], { _callJudge: judge, model: 'claude-opus-4-7' });

  assert.equal(judge.calls[0].model, 'claude-opus-4-7');
});

test('validateSignalBatch propagates judge errors', async () => {
  const judge = async () => { throw new Error('judge timed out'); };

  await assert.rejects(
    validateSignalBatch([makeObs(1)], { _callJudge: judge }),
    /judge timed out/,
  );
});

test('validateSignalBatch preserves judge response order across the result array', async () => {
  const judge = fakeJudge([
    { ...PASSING_VERDICT, idea: { ...PASSING_VERDICT.idea, title: 'Idea Zero' } },
    FAILING_VERDICT,
    { ...PASSING_VERDICT, idea: { ...PASSING_VERDICT.idea, title: 'Idea Two' } },
  ]);

  const results = await validateSignalBatch(
    [makeObs(0), makeObs(1), makeObs(2)],
    { _callJudge: judge },
  );

  assert.equal(results[0].idea.title, 'Idea Zero');
  assert.equal(results[1].idea, null);
  assert.equal(results[2].idea.title, 'Idea Two');
});
