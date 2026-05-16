// Pin the stderr format contract for lib/hook-log.js. The helper exists
// specifically because pre-existing call sites used inconsistent formats
// ("[mindwright/foo]" vs "mindwright/foo:" vs no prefix at all). Operators
// running `claude --debug` or tailing stderr filter on the prefix, so a
// silent refactor that changes the format would break their grep filters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logHookError } from '../lib/hook-log.js';

// Capture stderr writes for a single call. Restoring the original write
// after each test avoids cross-test contamination from node:test's
// stderr-based reporter.
function captureStderr(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured.join('');
}

test('logHookError emits exactly [mindwright/<hook>] <stage>: <message>\\n on Error input', () => {
  const out = captureStderr(() => {
    logHookError('pre-tool-use', 'flush failed', new Error('boom'));
  });
  assert.equal(out, '[mindwright/pre-tool-use] flush failed: boom\n',
    `format must be exact for grep-filter compatibility, got: ${JSON.stringify(out)}`);
});

test('logHookError stringifies non-Error values (string) into the message slot', () => {
  // A caller passing a bare string instead of an Error must not silently
  // produce "undefined" — the helper falls back to using the value directly.
  const out = captureStderr(() => {
    logHookError('stop', 'cap check', 'unexpected null row');
  });
  assert.equal(out, '[mindwright/stop] cap check: unexpected null row\n');
});

test('logHookError does not crash when passed null or undefined', () => {
  // The hook scripts call this from broad try/catch blocks; if the underlying
  // error is null (e.g., from a Promise.reject(null)) the helper must still
  // emit a line, not throw. Throwing would crash the hook subprocess and
  // Claude Code would surface the failure to the user.
  const out1 = captureStderr(() => {
    logHookError('session-start', 'open store', null);
  });
  assert.match(out1, /^\[mindwright\/session-start\] open store: /,
    `prefix must still be present even for null payload, got: ${JSON.stringify(out1)}`);
  assert.equal(out1.endsWith('\n'), true, 'output must terminate in a newline');

  const out2 = captureStderr(() => {
    logHookError('session-end', 'flush failed', undefined);
  });
  assert.match(out2, /^\[mindwright\/session-end\] flush failed: /);
  assert.equal(out2.endsWith('\n'), true);
});

test('logHookError prefers e.message over the raw object when available', () => {
  // Custom error-like objects with a .message field should produce just the
  // message, not the full object stringified — keeps the line concise and
  // matches Node's Error toString convention.
  const fakeErr = { message: 'permission denied', code: 'EACCES' };
  const out = captureStderr(() => {
    logHookError('user-prompt-submit', 'embed', fakeErr);
  });
  assert.equal(out, '[mindwright/user-prompt-submit] embed: permission denied\n');
});
