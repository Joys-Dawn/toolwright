import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVerdict as normalize } from '../../lib/miners/normalize-verdict.mjs';

const FULL_PASS = {
  is_real_need: true,
  pain_score_0_10: 7,
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

test('normalize passes through a fully-gated verdict', () => {
  const n = normalize(FULL_PASS);
  assert.equal(n.is_real_need, true);
  assert.equal(n.pain_score_0_10, 7);
  assert.ok(n.idea);
  assert.equal(n.idea.title, 'Semantic diff viewer for notebooks');
});

test('normalize nulls the idea when any gate fails', () => {
  for (const key of ['is_real_need', 'code_only', 'no_capital', 'no_private_data']) {
    const v = { ...FULL_PASS, [key]: false };
    assert.equal(normalize(v).idea, null, `gate=${key}`);
  }
});

test('normalize nulls the idea when pain_score is below 4', () => {
  const v = { ...FULL_PASS, pain_score_0_10: 3 };
  assert.equal(normalize(v).idea, null);
});

test('normalize nulls the idea when title is too short', () => {
  const v = { ...FULL_PASS, idea: { ...FULL_PASS.idea, title: 'X' } };
  assert.equal(normalize(v).idea, null);
});

test('normalize handles non-object input safely', () => {
  assert.deepEqual(normalize(null), { is_real_need: false, idea: null });
  assert.deepEqual(normalize('garbage'), { is_real_need: false, idea: null });
  assert.deepEqual(normalize(undefined), { is_real_need: false, idea: null });
});

test('normalize coerces missing pain_score to 0 and drops idea', () => {
  const v = { ...FULL_PASS };
  delete v.pain_score_0_10;
  const n = normalize(v);
  assert.equal(n.pain_score_0_10, 0);
  assert.equal(n.idea, null);
});

test('normalize preserves boolean gates in output', () => {
  const n = normalize(FULL_PASS);
  assert.equal(n.code_only, true);
  assert.equal(n.no_capital, true);
  assert.equal(n.no_private_data, true);
});
