import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCapabilityBatch } from '../../lib/miners/capability-validator.mjs';

// -- Fixtures ----------------------------------------------------------------

function makePaper(n, overrides = {}) {
  return {
    source: 'arxiv',
    source_url: `https://arxiv.org/abs/2404.${1000 + n}`,
    title: `A New Method ${n}`,
    quote: `We propose a novel approach ${n}.`,
    author: `Smith et al. ${n}`,
    created_at: '2024-04-01',
    code_url: `https://github.com/smith/method-${n}`,
    categories: ['cs.AI', 'cs.LG'],
    engagement: { citations: n },
    ...overrides,
  };
}

const PASSING = {
  is_real_need: true,
  pain_score_0_10: 8,
  code_only: true,
  no_capital: true,
  no_private_data: true,
  idea: {
    title: 'Semantic diff viewer for notebooks',
    summary: 'Uses the new X model to produce semantic notebook diffs.',
    target_user: 'data scientists doing code review',
    category: 'developer-tools',
    emerging_tech: 'arxiv:2404.12345',
    suggested_approach: 'Wrap the model in a VS Code extension.',
  },
};

const FAILING = {
  is_real_need: true,
  pain_score_0_10: 3,
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

test('validateCapabilityBatch issues one judge call and normalizes each result', async () => {
  const judge = fakeJudge([PASSING, FAILING, PASSING]);

  const results = await validateCapabilityBatch(
    [makePaper(1), makePaper(2), makePaper(3)],
    { _callJudge: judge },
  );

  assert.equal(judge.calls.length, 1, 'exactly one judge call for the whole batch');
  assert.equal(results.length, 3);
  assert.ok(results[0].idea);
  assert.equal(results[1].idea, null, 'low pain score gates out');
  assert.ok(results[2].idea);
});

test('validateCapabilityBatch returns empty array without calling judge for empty input', async () => {
  const judge = fakeJudge([]);

  const results = await validateCapabilityBatch([], { _callJudge: judge });

  assert.deepEqual(results, []);
  assert.equal(judge.calls.length, 0);
});

test('validateCapabilityBatch wraps non-array judge response into a single-element result', async () => {
  const judge = fakeJudge(PASSING);

  const results = await validateCapabilityBatch([makePaper(1)], { _callJudge: judge });

  assert.equal(results.length, 1);
  assert.ok(results[0].idea);
  assert.equal(results[0].idea.emerging_tech, 'arxiv:2404.12345');
});

test('validateCapabilityBatch maps observation fields to paper-shaped judge input', async () => {
  const judge = fakeJudge([PASSING]);
  const obs = makePaper(1, { internal_field: 'should be stripped' });

  await validateCapabilityBatch([obs], { _callJudge: judge });

  const sent = JSON.parse(judge.calls[0].user);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].abstract, obs.quote, 'quote field is renamed to abstract');
  assert.equal(sent[0].authors, obs.author, 'author field is renamed to authors');
  assert.equal(sent[0].published, obs.created_at, 'created_at is renamed to published');
  assert.equal(sent[0].code_url, obs.code_url);
  assert.deepEqual(sent[0].categories, ['cs.AI', 'cs.LG']);
  assert.ok(!('quote' in sent[0]));
  assert.ok(!('author' in sent[0]));
  assert.ok(!('created_at' in sent[0]));
  assert.ok(!('internal_field' in sent[0]));
});

test('validateCapabilityBatch defaults code_url and categories to null when missing', async () => {
  const judge = fakeJudge([PASSING]);
  const obs = makePaper(1);
  delete obs.code_url;
  delete obs.categories;

  await validateCapabilityBatch([obs], { _callJudge: judge });

  const sent = JSON.parse(judge.calls[0].user);
  assert.equal(sent[0].code_url, null);
  assert.equal(sent[0].categories, null);
});

test('validateCapabilityBatch passes model option through to the judge', async () => {
  const judge = fakeJudge([PASSING]);

  await validateCapabilityBatch(
    [makePaper(1)],
    { _callJudge: judge, model: 'claude-opus-4-7' },
  );

  assert.equal(judge.calls[0].model, 'claude-opus-4-7');
});

test('validateCapabilityBatch propagates judge errors', async () => {
  const judge = async () => { throw new Error('judge timed out'); };

  await assert.rejects(
    validateCapabilityBatch([makePaper(1)], { _callJudge: judge }),
    /judge timed out/,
  );
});
