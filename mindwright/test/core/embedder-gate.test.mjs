// Regression for behavior-8: a /mindwright:dream (or recall, retain-long,
// or resolve-merge) run before /mindwright:setup must NOT trigger the
// 5 GB bge-m3 download. The gate at the MCP handler boundary returns a
// clean errResponse with a setup hint instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleToolCall } from '../../lib/tools.mjs';
import { openStore } from '../../lib/store.js';

async function withEnvGate(fn) {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const fakeHome = mkdtempSync(join(tmpdir(), 'mw-gate-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'mw-gate-proj-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.MINDWRIGHT_PROJECT_ROOT = projectDir;
  // Critical: stubs OFF so embedderCached() consults the (empty) cache dir.
  delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  const store = openStore();
  store.setSessionId('gate-test');
  try {
    // Critical: `return await fn(...)` not `return fn(...)`. With the bare
    // `return`, the finally below runs before the inner Promise resolves
    // — closing the store mid-flight under a mutating handler. That used
    // to be hidden because mutating handlers called renderAll INSIDE the
    // synchronous handler body; the best-practices-6 refactor moved
    // renderAll to the dispatcher continuation (post-await), surfacing
    // the latent close-before-resolve bug.
    return await fn({ store });
  } finally {
    try { store.close(); } catch { /* already closed */ }
    if (prevStub !== undefined) process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    if (prevProjectRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
}

// Fail-loud: if the gate doesn't catch the missing cache, this fake embed
// trips the test instead of silently triggering a 5 GB download in CI.
const TRIPWIRE_EMBED = () => {
  throw new Error('TRIPWIRE: embed called despite missing model cache');
};

function isSetupHintError(result) {
  if (!result || !result.isError) return false;
  if (!Array.isArray(result.content) || !result.content[0]) return false;
  const payload = JSON.parse(result.content[0].text);
  return typeof payload.error === 'string' && /mindwright:setup/.test(payload.error);
}

test('mindwright_recall returns a setup hint instead of triggering model download', async () => {
  await withEnvGate(async ({ store }) => {
    const result = await handleToolCall(
      'mindwright_recall',
      { query: 'anything' },
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    assert.ok(isSetupHintError(result),
      `expected setup-hint errResponse, got ${JSON.stringify(result)}`);
  });
});

test('mindwright_retain (tier=long) returns a setup hint instead of triggering model download', async () => {
  await withEnvGate(async ({ store }) => {
    const result = await handleToolCall(
      'mindwright_retain',
      { content: 'a long-term fact', kind: 'fact', tier: 'long', category: 'fact', scope: 'project' },
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    assert.ok(isSetupHintError(result),
      `expected setup-hint errResponse, got ${JSON.stringify(result)}`);
  });
});

test('mindwright_retain (tier=short) succeeds with NULL embedding when model not cached', async () => {
  await withEnvGate(async ({ store }) => {
    const result = await handleToolCall(
      'mindwright_retain',
      { content: 'a short-term note', kind: 'note', tier: 'short' },
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    assert.notEqual(result.isError, true,
      `short-term retain must succeed even without the model cache, got ${JSON.stringify(result)}`);
    const payload = JSON.parse(result.content[0].text);
    assert.ok(typeof payload.id === 'number');
  });
});

test('mindwright_retain_fact returns a setup hint instead of triggering model download', async () => {
  await withEnvGate(async ({ store }) => {
    const result = await handleToolCall(
      'mindwright_retain_fact',
      {
        content: 'distilled fact',
        category: 'fact',
        scope: 'project',
        drain_id: 'fake-drain',
        exchange_id: 'ex-0',
      },
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    assert.ok(isSetupHintError(result),
      `expected setup-hint errResponse, got ${JSON.stringify(result)}`);
  });
});

test('mindwright_status surfaces a stale-user-scoped-fact hint when oldest active preference is >= 60 days old', async () => {
  // DESIGN.md "Future thoughts": time-based decay is post-v1. The behavior
  // gap is real (a 6-month-old preference is just as eligible for retrieval
  // as a 2-day-old one). Workaround: status now exposes oldest_preference_at
  // and adds a warning when it crosses the audit threshold (~60 days).
  await withEnvGate(async ({ store }) => {
    // Plant an active fact/user row dated 200 days ago. Use raw INSERT
    // so we control created_at — insertEntry stamps it as Date.now().
    const ancient = new Date(Date.now() - 200 * 86_400_000).toISOString();
    store.db.prepare(
      `INSERT INTO entries (tier, category, scope, kind, content, session_id, created_at, active)
       VALUES ('long', 'fact', 'user', 'fact', ?, 'gate-test', ?, 1)`,
    ).run('user prefers tabs to spaces', ancient);

    const result = await handleToolCall(
      'mindwright_status',
      {},
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.oldest_preference_at, ancient);
    const hasStaleHint = payload.warnings.some((w) =>
      /oldest active user-scoped fact/.test(w) && /days old/.test(w));
    assert.ok(hasStaleHint,
      `expected stale-preference warning, got: ${JSON.stringify(payload.warnings)}`);
  });
});

test('mindwright_status does NOT add the stale-preference hint for fresh preferences', async () => {
  await withEnvGate(async ({ store }) => {
    // Recent preference — only a few days old. Should NOT trip the warning.
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    store.db.prepare(
      `INSERT INTO entries (tier, category, scope, kind, content, session_id, created_at, active)
       VALUES ('long', 'fact', 'user', 'fact', ?, 'gate-test', ?, 1)`,
    ).run('user prefers TypeScript over JavaScript', recent);

    const result = await handleToolCall(
      'mindwright_status',
      {},
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.oldest_preference_at, recent);
    const hasStaleHint = payload.warnings.some((w) =>
      /oldest active user-scoped fact/.test(w));
    assert.ok(!hasStaleHint,
      `fresh preference must not trip the warning, got: ${JSON.stringify(payload.warnings)}`);
  });
});

test('mindwright_status surfaces a warning when daemon_alive=false AND pending_embeds>0', async () => {
  // Behavior regression: a user seeing pending_embeds>0 with no warning had
  // no signal that the sweeper requires the daemon. Without the warning
  // they wait expecting auto-resolution that will never happen until a new
  // mindwright-bound session opens.
  await withEnvGate(async ({ store }) => {
    // Seed a row with NULL embedding (sweeper-pending shape). Use scope=short
    // so we don't need to deal with category gating.
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'pending sweep', sessionId: 'gate-test',
    });
    // No daemon ticket dir + no daemon = isDaemonAlive() returns false naturally.
    const result = await handleToolCall(
      'mindwright_status',
      {},
      { store, sessionId: 'gate-test', embed: TRIPWIRE_EMBED, rerank: TRIPWIRE_EMBED },
    );
    assert.notEqual(result.isError, true, 'status must not error');
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.daemon_alive, false, 'precondition: no daemon');
    assert.ok(payload.pending_embeds > 0, 'precondition: pending row exists');
    const hasDaemonHint = payload.warnings.some((w) => /no mindwright daemon/.test(w));
    assert.ok(hasDaemonHint,
      `expected a daemon-down + pending-embeds warning, got: ${JSON.stringify(payload.warnings)}`);
  });
});
