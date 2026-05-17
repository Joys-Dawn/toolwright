// scripts/mindwright.mjs — the CLI that replaces the MCP server. Skills run
// `node scripts/mindwright.mjs <tool> --session-id <id>` with JSON args on
// stdin; the script dispatches into the SAME lib/tools.mjs handlers and
// prints the unwrapped JSON payload to stdout.
//
// `status` is the ideal smoke target: it exercises the full path (argv
// parse → store open → handleToolCall → envelope unwrap → stdout JSON)
// without needing the model daemon, so the test never spawns ONNX.

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
