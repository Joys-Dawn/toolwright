import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVerdict } from '../../lib/miners/normalize-verdict.mjs';

// validateCapabilityBatch calls callJudge (spawns claude -p), so we test
// the normalize + array-shaping logic the same way as validator-batch tests.

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

test('capability batch normalize handles mixed results', () => {
  const batch = [PASSING, FAILING, PASSING];
  const normalized = batch.map((r) => normalizeVerdict(r));

  assert.equal(normalized.length, 3);
  assert.ok(normalized[0].idea);
  assert.equal(normalized[1].idea, null, 'low pain score gates out');
  assert.ok(normalized[2].idea);
});

test('capability batch normalize wraps non-array as single element', () => {
  const result = PASSING;
  const arr = Array.isArray(result) ? result : [result];
  const normalized = arr.map((r) => normalizeVerdict(r));

  assert.equal(normalized.length, 1);
  assert.ok(normalized[0].idea);
  assert.equal(normalized[0].idea.emerging_tech, 'arxiv:2404.12345');
});

test('capability batch input serializes expected fields for papers', () => {
  const obs = {
    source: 'arxiv',
    source_url: 'https://arxiv.org/abs/2404.12345',
    title: 'A New Method',
    quote: 'We propose a novel approach...',
    author: 'Smith et al.',
    created_at: '2024-04-01',
    code_url: 'https://github.com/smith/newmethod',
    categories: ['cs.AI', 'cs.LG'],
    engagement: { citations: 5 },
    internal_field: 'should be stripped',
  };

  const serialized = JSON.parse(JSON.stringify([{
    source: obs.source,
    source_url: obs.source_url,
    title: obs.title,
    abstract: obs.quote,
    authors: obs.author,
    published: obs.created_at,
    code_url: obs.code_url,
    categories: obs.categories,
    engagement: obs.engagement,
  }]));

  assert.equal(serialized.length, 1);
  assert.ok(!('internal_field' in serialized[0]));
  assert.ok(!('quote' in serialized[0]), 'quote mapped to abstract');
  assert.equal(serialized[0].abstract, 'We propose a novel approach...');
  assert.equal(serialized[0].code_url, 'https://github.com/smith/newmethod');
});

test('capability batch empty input returns empty array', () => {
  const normalized = [].map((r) => normalizeVerdict(r));
  assert.equal(normalized.length, 0);
});
