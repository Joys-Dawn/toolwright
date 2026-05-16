import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCapability } from '../../lib/miners/capability-validator.mjs';

// -- Fixtures (mirror capability-validator-batch.test.mjs) -------------------

function makePaper(overrides = {}) {
  return {
    source: 'arxiv',
    source_url: 'https://arxiv.org/abs/2404.12345',
    title: 'A New Method',
    quote: 'We propose a novel approach to the problem.',
    author: 'Smith et al.',
    created_at: '2024-04-01',
    code_url: 'https://github.com/smith/method',
    categories: ['cs.AI', 'cs.LG'],
    engagement: { citations: 12 },
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

test('validateCapability remaps observation fields into the paper-shaped judge input', async () => {
  const judge = fakeJudge(PASSING);
  const obs = makePaper({ internal_field: 'strip me' });

  await validateCapability(obs, { _callJudge: judge });

  const sent = JSON.parse(judge.calls[0].user);
  assert.equal(sent.abstract, obs.quote, 'quote → abstract');
  assert.equal(sent.authors, obs.author, 'author → authors');
  assert.equal(sent.published, obs.created_at, 'created_at → published');
  assert.equal(sent.code_url, obs.code_url);
  assert.deepEqual(sent.categories, ['cs.AI', 'cs.LG']);
  assert.ok(!('quote' in sent));
  assert.ok(!('author' in sent));
  assert.ok(!('created_at' in sent));
  assert.ok(!('internal_field' in sent));
});

test('validateCapability defaults code_url and categories to null when absent', async () => {
  const judge = fakeJudge(PASSING);
  const obs = makePaper();
  delete obs.code_url;
  delete obs.categories;

  await validateCapability(obs, { _callJudge: judge });

  const sent = JSON.parse(judge.calls[0].user);
  assert.equal(sent.code_url, null);
  assert.equal(sent.categories, null);
});

test('validateCapability threads model and timeoutMs through to the judge call', async () => {
  const judge = fakeJudge(PASSING);

  await validateCapability(makePaper(), { _callJudge: judge, model: 'claude-opus-4-7', timeoutMs: 9000 });

  assert.equal(judge.calls[0].model, 'claude-opus-4-7');
  assert.equal(judge.calls[0].timeoutMs, 9000);
});

test('validateCapability omits model and timeoutMs when not supplied', async () => {
  const judge = fakeJudge(PASSING);

  await validateCapability(makePaper(), { _callJudge: judge });

  assert.equal('model' in judge.calls[0], false);
  assert.equal('timeoutMs' in judge.calls[0], false);
});

test('validateCapability returns a normalized passing verdict with the idea intact', async () => {
  const judge = fakeJudge(PASSING);

  const v = await validateCapability(makePaper(), { _callJudge: judge });

  assert.deepEqual(v.idea, PASSING.idea);
  assert.equal(v.is_real_need, true);
  assert.equal(v.pain_score_0_10, 8);
});

test('validateCapability gates the idea to null on a failing verdict', async () => {
  const judge = fakeJudge(FAILING);

  const v = await validateCapability(makePaper(), { _callJudge: judge });

  assert.equal(v.idea, null);
  assert.equal(v.is_real_need, true, 'non-idea fields still reflect the verdict');
});

test('validateCapability coerces a non-object judge result to a rejected verdict', async () => {
  const judge = fakeJudge(null);

  const v = await validateCapability(makePaper(), { _callJudge: judge });

  assert.deepEqual(v, { is_real_need: false, idea: null });
});

test('validateCapability propagates judge errors', async () => {
  const judge = async () => { throw new Error('judge timed out'); };

  await assert.rejects(validateCapability(makePaper(), { _callJudge: judge }), /judge timed out/);
});
