import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignal } from '../../lib/miners/validator.mjs';

// -- Fixtures (mirror validator-batch.test.mjs) ------------------------------

function makeObs(overrides = {}) {
  return {
    source: 'reddit',
    source_url: 'https://reddit.com/r/x/1',
    title: 'Post 1',
    quote: 'I wish there was a tool for this problem',
    author: 'user1',
    engagement: { upvotes: 42 },
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

test('validateSignal sends ONLY the six documented observation fields to the judge', async () => {
  const judge = fakeJudge(PASSING_VERDICT);
  const obs = makeObs({ extra_field: 'strip me', internal_id: 999 });

  await validateSignal(obs, { _callJudge: judge });

  assert.equal(judge.calls.length, 1);
  const sent = JSON.parse(judge.calls[0].user);
  assert.deepEqual(Object.keys(sent).sort(), [
    'author', 'engagement', 'quote', 'source', 'source_url', 'title',
  ]);
  assert.equal(sent.title, 'Post 1');
  assert.ok(!('extra_field' in sent));
  assert.ok(!('internal_id' in sent));
});

test('validateSignal threads model and timeoutMs through to the judge call', async () => {
  const judge = fakeJudge(PASSING_VERDICT);

  await validateSignal(makeObs(), { _callJudge: judge, model: 'claude-opus-4-7', timeoutMs: 5000 });

  assert.equal(judge.calls[0].model, 'claude-opus-4-7');
  assert.equal(judge.calls[0].timeoutMs, 5000);
});

test('validateSignal omits model and timeoutMs when not supplied', async () => {
  const judge = fakeJudge(PASSING_VERDICT);

  await validateSignal(makeObs(), { _callJudge: judge });

  assert.equal('model' in judge.calls[0], false);
  assert.equal('timeoutMs' in judge.calls[0], false);
});

test('validateSignal returns a normalized passing verdict with the idea intact', async () => {
  const judge = fakeJudge(PASSING_VERDICT);

  const v = await validateSignal(makeObs(), { _callJudge: judge });

  assert.deepEqual(v.idea, PASSING_VERDICT.idea);
  assert.equal(v.is_real_need, true);
  assert.equal(v.pain_score_0_10, 7);
  assert.equal(v.code_only, true);
});

test('validateSignal gates the idea to null when a hard constraint fails', async () => {
  const judge = fakeJudge({ ...PASSING_VERDICT, no_capital: false });

  const v = await validateSignal(makeObs(), { _callJudge: judge });

  assert.equal(v.idea, null, 'no_capital=false must zero out the idea');
  assert.equal(v.is_real_need, true, 'other fields still reflect the verdict');
  assert.equal(v.no_capital, false);
});

test('validateSignal gates the idea to null when pain_score is below the threshold', async () => {
  const judge = fakeJudge({ ...PASSING_VERDICT, pain_score_0_10: 3 });

  const v = await validateSignal(makeObs(), { _callJudge: judge });

  assert.equal(v.idea, null, 'pain_score < 4 is too trivial → gated');
  assert.equal(v.pain_score_0_10, 3);
});

test('validateSignal coerces a non-object judge result to a rejected verdict', async () => {
  const judge = fakeJudge('garbage-not-an-object');

  const v = await validateSignal(makeObs(), { _callJudge: judge });

  assert.deepEqual(v, { is_real_need: false, idea: null });
});

test('validateSignal propagates judge errors', async () => {
  const judge = async () => { throw new Error('judge timed out'); };

  await assert.rejects(validateSignal(makeObs(), { _callJudge: judge }), /judge timed out/);
});
