// Coverage for mindwright_finalize_drain's input validation. A malformed
// drain_id ("all||5" with empty cutoff_ts) used to slip past the handler
// and reach finalizeDrain with an empty-string drainCutoff, which then
// fell through the WHERE-clause guards (empty string is falsy in both
// branches) and ran the DELETE with no temporal filter — wiping every
// active short-term row in scope. The handler now rejects empty / unparseable
// cutoff_ts; finalizeDrain itself throws as a second line of defense.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openStore } from '../../lib/store.js';
import { finalizeDrain } from '../../lib/consolidator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const SERVER_PATH = join(PLUGIN_ROOT, 'mcp', 'server.mjs');

function setupSandbox(label) {
  const dir = mkdtempSync(join(tmpdir(), `mindwright-fd-${label}-`));
  const sessionId = `mw-test-${label}-${process.pid}-${Date.now()}`;
  return {
    dir,
    sessionId,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
}

// In-process store helper for the finalizeDrain *internal* tests (which call
// finalizeDrain directly rather than over the MCP wire). openStore() reads
// MINDWRIGHT_PROJECT_ROOT from process.env, so these tests must mutate it —
// unlike the MCP-level tests, which pass it through the spawned subprocess's
// `env:`. Snapshot + restore the var (and delete the tmp dir) so a leaked
// MINDWRIGHT_PROJECT_ROOT doesn't point every subsequent test at a just-
// rmSync'd path. Mirrors withStore/withTmp in the sibling suites.
function withInternalStore(label, fn) {
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), `mindwright-fd-${label}-`));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return fn(store);
  } finally {
    try { store.close(); } catch { /* */ }
    rmSync(dir, { recursive: true, force: true });
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
  }
}

async function connect({ projectRoot, sessionId }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: projectRoot,
    env: {
      ...process.env,
      MINDWRIGHT_PROJECT_ROOT: projectRoot,
      MINDWRIGHT_SESSION_ID: sessionId,
      MINDWRIGHT_USE_STUB_MODELS: '1',
    },
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'fd-test', version: '0.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

function unwrap(result) {
  assert.ok(result && Array.isArray(result.content));
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------
// MCP handler — empty cutoff_ts must be rejected
// ---------------------------------------------------------------

test('finalize_drain rejects drain_id with empty cutoff_ts segment', async () => {
  const sb = setupSandbox('empty-ts');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      // Plant a short-term row so an unbounded DELETE would be visible.
      await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: 'survivor', kind: 'note', tier: 'short' },
      });
      const raw = await client.callTool({
        name: 'mindwright_finalize_drain',
        arguments: { drain_id: 'all||5' },
      });
      assert.ok(raw.isError, 'response must signal error');
      const body = unwrap(raw);
      assert.match(body.error, /cutoff_ts/i);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('finalize_drain rejects drain_id with garbage cutoff_ts segment', async () => {
  const sb = setupSandbox('garbage-ts');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      const raw = await client.callTool({
        name: 'mindwright_finalize_drain',
        arguments: { drain_id: 'all|not-a-date|7' },
      });
      assert.ok(raw.isError);
      const body = unwrap(raw);
      assert.match(body.error, /cutoff_ts/i);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('finalize_drain rejects drain_id with empty scope segment', async () => {
  const sb = setupSandbox('empty-scope');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      const raw = await client.callTool({
        name: 'mindwright_finalize_drain',
        arguments: { drain_id: '|2026-05-13T05:00:00.000Z|7' },
      });
      assert.ok(raw.isError);
      const body = unwrap(raw);
      assert.match(body.error, /scope/i);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------
// BOLA defense — scope segment must match caller's session
// ---------------------------------------------------------------
//
// drain_id is generated by drainBatch and passed back through the LLM. A
// prompt-injected memory could forge a scope segment ("other-session" or
// "all") to trick the calling Claude into hard-deleting another session's
// short-term rows. finalizeDrainHandler must reject any drain_id whose
// scope segment is neither ctx.sessionId nor 'all'. scope='all' must
// additionally require confirm_all_sessions:true. OWASP API1:2023 / CWE-639.

test('finalize_drain rejects drain_id whose scope is a different session', async () => {
  const sb = setupSandbox('cross-session');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      // Plant a short-term row under the CURRENT session so an unbounded
      // DELETE would have something visible to wipe — proves the row
      // survives the rejection.
      await client.callTool({
        name: 'mindwright_retain',
        arguments: { content: 'survivor', kind: 'note', tier: 'short' },
      });
      // Forged drain_id with another session's id in the scope segment.
      const raw = await client.callTool({
        name: 'mindwright_finalize_drain',
        arguments: { drain_id: 'sess-other|2026-05-13T05:00:00.000Z|9999' },
      });
      assert.ok(raw.isError, 'cross-session finalize must error');
      const body = unwrap(raw);
      assert.match(body.error, /does not match/);

      // Survivor still present.
      const status = unwrap(
        await client.callTool({ name: 'mindwright_status', arguments: {} }),
      );
      assert.ok(status.short_count >= 1, 'short-term row must survive rejection');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test("finalize_drain rejects drain_id with scope='all' when confirm_all_sessions is not true", async () => {
  const sb = setupSandbox('all-no-confirm');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      const raw = await client.callTool({
        name: 'mindwright_finalize_drain',
        arguments: { drain_id: 'all|2026-05-13T05:00:00.000Z|9999' },
      });
      assert.ok(raw.isError);
      const body = unwrap(raw);
      assert.match(body.error, /confirm_all_sessions/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test("finalize_drain rejects drain_id with scope='all' when confirm_all_sessions is the string 'true' (must be boolean true)", async () => {
  const sb = setupSandbox('all-string-confirm');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      const raw = await client.callTool({
        name: 'mindwright_finalize_drain',
        arguments: {
          drain_id: 'all|2026-05-13T05:00:00.000Z|9999',
          confirm_all_sessions: 'true',
        },
      });
      assert.ok(raw.isError, 'string "true" must not satisfy the boolean check');
      const body = unwrap(raw);
      assert.match(body.error, /confirm_all_sessions/);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test("finalize_drain accepts drain_id whose scope matches the caller's session", async () => {
  const sb = setupSandbox('matching-scope');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      // Plant enough rows so drainBatch produces a real drain_id (drainPct=0.7).
      for (let i = 0; i < 6; i++) {
        await client.callTool({
          name: 'mindwright_retain',
          arguments: { content: `row-${i}`, kind: 'thinking', tier: 'short' },
        });
      }
      const batch = unwrap(
        await client.callTool({
          name: 'mindwright_drain_batch',
          arguments: { scope: 'session' },
        }),
      );
      assert.ok(batch.drain_id, 'drain_batch must produce a drain_id');
      // The scope segment of drain_id must be the caller's session.
      const [scope] = batch.drain_id.split('|');
      assert.equal(scope, sb.sessionId, 'scope segment matches caller session');
      // finalize must succeed.
      const finalRes = unwrap(
        await client.callTool({
          name: 'mindwright_finalize_drain',
          arguments: { drain_id: batch.drain_id },
        }),
      );
      assert.ok(typeof finalRes.drained_count === 'number');
      assert.ok(finalRes.drained_count >= 1);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

test("finalize_drain accepts drain_id with scope='all' when confirm_all_sessions:true", async () => {
  const sb = setupSandbox('all-confirm');
  try {
    const { client, transport } = await connect({ projectRoot: sb.dir, sessionId: sb.sessionId });
    try {
      for (let i = 0; i < 6; i++) {
        await client.callTool({
          name: 'mindwright_retain',
          arguments: { content: `row-${i}`, kind: 'thinking', tier: 'short' },
        });
      }
      const batch = unwrap(
        await client.callTool({
          name: 'mindwright_drain_batch',
          arguments: { scope: 'all' },
        }),
      );
      assert.ok(batch.drain_id);
      const [scope] = batch.drain_id.split('|');
      assert.equal(scope, 'all');
      const finalRes = unwrap(
        await client.callTool({
          name: 'mindwright_finalize_drain',
          arguments: { drain_id: batch.drain_id, confirm_all_sessions: true },
        }),
      );
      assert.ok(typeof finalRes.drained_count === 'number');
      assert.ok(finalRes.drained_count >= 1);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------
// finalizeDrain (internal) — defensive throw on missing cutoff
// ---------------------------------------------------------------

test('finalizeDrain throws when drainCutoff is empty (defense in depth)', () => {
  withInternalStore('internal', (store) => {
    // Plant a short-term row that an unbounded DELETE would consume.
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'survivor', sessionId: 'sess',
    });

    assert.throws(
      () => finalizeDrain({ store, drainId: 'sess||1', drainCutoff: '', drainCutoffId: 1, sessionId: 'sess' }),
      /drainCutoff/,
    );
    assert.throws(
      () => finalizeDrain({ store, drainId: 'sess|2026|x', drainCutoff: '2026', drainCutoffId: NaN, sessionId: 'sess' }),
      /drainCutoffId/,
    );

    // Survivor still present — the unbounded DELETE never ran.
    const remaining = store.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tier='short' AND active=1`,
    ).get();
    assert.equal(remaining.n, 1, 'short-term row must survive a refused finalizeDrain');
  });
});

test('finalizeDrain throws on a non-ISO truthy drainCutoff (regression)', () => {
  // Regression: a non-ISO truthy string (e.g. 'foo') used to slip past the
  // truthiness-only gate and reach SQLite's `(created_at, id) <= (?, ?)`
  // tuple comparator. ASCII letters lexically out-rank ISO timestamps
  // ('2026-...' < 'foo'), so the predicate would match every active row
  // and the DELETE would wipe the whole short-term tier instead of just
  // the drained partition. Validation now enforces Date.parse-able input.
  withInternalStore('nonISO', (store) => {
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'survivor-A', sessionId: 'sess',
    });
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'survivor-B', sessionId: 'sess',
    });

    assert.throws(
      () => finalizeDrain({
        store, drainId: 'sess|foo|1', drainCutoff: 'foo', drainCutoffId: 1, sessionId: 'sess',
      }),
      /drainCutoff/,
      'non-ISO truthy drainCutoff must throw',
    );
    assert.throws(
      () => finalizeDrain({
        store, drainId: 'sess|bar|1', drainCutoff: 'not-a-date', drainCutoffId: 1, sessionId: 'sess',
      }),
      /drainCutoff/,
    );

    // Both survivors still present.
    const remaining = store.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tier='short' AND active=1`,
    ).get();
    assert.equal(remaining.n, 2, 'over-delete must not have run');
  });
});

test('finalizeDrain validation errors carry typed err.code for programmatic discrimination', () => {
  withInternalStore('code', (store) => {
    let thrown = null;
    try {
      finalizeDrain({ store, drainId: 'sess||1', drainCutoff: '', drainCutoffId: 1, sessionId: 'sess' });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'expected throw');
    assert.equal(thrown.code, 'INVALID_DRAIN_CUTOFF',
      'cutoff-related throw must carry INVALID_DRAIN_CUTOFF for the MCP error_code surface');

    thrown = null;
    try {
      finalizeDrain({ store, drainId: '', drainCutoff: '2026-05-13', drainCutoffId: 1, sessionId: 'sess' });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'expected throw');
    assert.equal(thrown.code, 'INVALID_DRAIN_ID',
      'drainId-related throw must carry INVALID_DRAIN_ID for the MCP error_code surface');
  });
});
