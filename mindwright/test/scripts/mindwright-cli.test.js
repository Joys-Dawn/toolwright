// scripts/mindwright.mjs — the CLI that replaces the MCP server. Skills run
// `node scripts/mindwright.mjs <tool> --session-id <id>` with JSON args on
// stdin; the script dispatches into the SAME lib/tools.mjs handlers and
// prints the unwrapped JSON payload to stdout.
//
// `status` is the ideal smoke target: it exercises the full path (argv
// parse → store open → handleToolCall → envelope unwrap → stdout JSON)
// without needing the model daemon, so the test never spawns ONNX.
//
// Also pinned here (these were the deleted MCP session-bind suite's job):
//   - the no-`--session-id` author fallback (store.setSessionId(sid ||
//     UNBOUND_SESSION_ID)): a session-gated write is *refused* (never a
//     NULL/orphan row), and read-only `status` still runs under the unbound
//     author. The positive "rows land in the unbound bucket" half is a
//     store-layer concern already covered by store.test.js — no CLI path
//     writes entries unbound because every entry-writer is session-gated.
//   - parseArgv's inline `--session-id=<id>` / `--args=<json>` forms;
//   - the `--args` invalid-JSON branch (distinct from the stdin one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// test/scripts/<file> → repo root is three dirnames up.
const SCRIPT = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'scripts',
  'mindwright.mjs',
);

function runCli(args, { dir, stdin = '' } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      MINDWRIGHT_PROJECT_ROOT: dir,
      // A degrade-to-null embed must never fork a real ONNX daemon in tests.
      MINDWRIGHT_MODEL_DAEMON_DISABLE: '1',
    },
  });
}

function withRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-cli-'));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('status: dispatches into the handler and prints the unwrapped JSON payload', () => {
  withRoot((dir) => {
    const res = runCli(['status', '--session-id', 'aaaaaaaa-1111-4111-8111-111111111111'], { dir });
    assert.equal(res.status, 0, `exit 0 expected; stderr=${res.stderr}`);
    const payload = JSON.parse(res.stdout.trim());
    // okResponse(statusHandler) shape — not the MCP {content:[...]} envelope.
    assert.ok('short_count' in payload, `expected status payload, got ${res.stdout}`);
    assert.ok('long_count' in payload);
    assert.ok('model_cached' in payload);
    assert.equal(payload.short_count, 0, 'fresh store has no short rows');
  });
});

test('unknown tool → structured error JSON on stdout, still exit 0', () => {
  withRoot((dir) => {
    const res = runCli(['definitely_not_a_tool'], { dir });
    assert.equal(res.status, 0);
    const payload = JSON.parse(res.stdout.trim());
    assert.match(payload.error, /unknown tool/i);
  });
});

test('no tool arg → usage error JSON', () => {
  withRoot((dir) => {
    const res = runCli([], { dir });
    assert.equal(res.status, 0);
    const payload = JSON.parse(res.stdout.trim());
    assert.match(payload.error, /usage:/);
  });
});

test('args object is read from stdin (JSON heredoc contract)', () => {
  withRoot((dir) => {
    // recall validates args before embedding: a non-string query is rejected
    // by the handler, proving stdin JSON reached it (no daemon involved).
    const res = runCli(['recall', '--session-id', 'bbbbbbbb-2222-4222-8222-222222222222'], {
      dir,
      stdin: JSON.stringify({ query: '' }),
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const payload = JSON.parse(res.stdout.trim());
    assert.match(payload.error, /query must be a non-empty string/);
  });
});

test('invalid stdin JSON → clean error, no crash', () => {
  withRoot((dir) => {
    const res = runCli(['status'], { dir, stdin: '{not json' });
    assert.equal(res.status, 0);
    const payload = JSON.parse(res.stdout.trim());
    assert.match(payload.error, /not valid JSON/);
  });
});

test('no --session-id: a session-gated write is refused (not NULL-authored) and status still runs under the UNBOUND author', () => {
  withRoot((dir) => {
    // retain ∈ TOOLS_REQUIRING_SESSION: with no --session-id the dispatcher
    // must reject it BEFORE any write — the safety the constants.js comment
    // calls load-bearing (rows can never get a NULL author).
    const w = runCli(['retain'], {
      dir,
      stdin: JSON.stringify({ content: 'should-never-persist', kind: 'thinking', tier: 'short' }),
    });
    assert.equal(w.status, 0, `exit 0 expected; stderr=${w.stderr}`);
    assert.match(JSON.parse(w.stdout.trim()).error, /needs a session id/i);

    // status is read-only (not gated). With no --session-id the store author
    // falls back to UNBOUND_SESSION_ID — the read must succeed (proving that
    // fallback is a *valid* author, not a crash) and prove the refused write
    // leaked nothing: zero rows under the unbound bucket.
    const s = runCli(['status'], { dir });
    assert.equal(s.status, 0, `exit 0 expected; stderr=${s.stderr}`);
    const sp = JSON.parse(s.stdout.trim());
    assert.equal(sp.unbound_count, 0, 'a refused session-less write must not leak an unbound/NULL row');
  });
});

test('parseArgv honors the inline = forms: --session-id=<id> passes the gate and --args=<json> feeds the handler', () => {
  withRoot((dir) => {
    const res = runCli(
      [
        'retain',
        '--session-id=cccccccc-3333-4333-8333-333333333333',
        '--args={"content":"viaInlineArgs","kind":"thinking","tier":"short"}',
      ],
      { dir },
    );
    assert.equal(res.status, 0, `exit 0 expected; stderr=${res.stderr}`);
    const p = JSON.parse(res.stdout.trim());
    // Positive contract: a short-tier retain returns a numeric row id and no
    // error (the same success shape asserted in core/embedder-gate.test.mjs
    // for this exact case). This is what actually proves BOTH inline forms
    // reached a working handler — ANY regression fails here, including a
    // third mode the two negative checks below would miss (a different
    // validation error, a store failure, or an unexpected success shape).
    assert.equal(p.error, undefined, `retain must succeed; got error: ${res.stdout}`);
    assert.ok(typeof p.id === 'number', `retain must return a numeric row id; got ${res.stdout}`);
    // Diagnostics only: if the contract above ever fails, these pinpoint
    // WHICH inline form regressed (gate rejected vs. stdin fell through).
    assert.ok(!/needs a session id/i.test(JSON.stringify(p)), `--session-id= not honored: ${res.stdout}`);
    assert.ok(
      !/content must be a non-empty string/i.test(p.error || ''),
      `--args= not honored (stdin fell through): ${res.stdout}`,
    );
  });
});

test('--args with invalid JSON → structured error (the inline-arg parse path, distinct from stdin)', () => {
  withRoot((dir) => {
    const res = runCli(['status', '--args', '{not: json'], { dir });
    assert.equal(res.status, 0);
    const p = JSON.parse(res.stdout.trim());
    assert.match(p.error, /--args is not valid JSON/);
  });
});
