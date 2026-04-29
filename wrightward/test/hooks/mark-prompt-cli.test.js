'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { readMarker } = require('../../lib/last-prompt');

const HOOK = path.resolve(__dirname, '../../hooks/mark-prompt-cli.js');

function runHook(input) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
}

describe('mark-prompt-cli hook (UserPromptSubmit)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-prompt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a cli marker for the session', () => {
    const collabDir = ensureCollabDir(tmpDir);
    runHook({ session_id: 'sess-1', cwd: tmpDir });
    const m = readMarker(collabDir, 'sess-1');
    assert.equal(m.channel, 'cli');
    assert.ok(m.ts > 0);
  });

  it('overwrites a prior discord marker with cli', () => {
    const collabDir = ensureCollabDir(tmpDir);
    const { writeMarker } = require('../../lib/last-prompt');
    writeMarker(collabDir, 'sess-1', 'discord');

    runHook({ session_id: 'sess-1', cwd: tmpDir });

    assert.equal(readMarker(collabDir, 'sess-1').channel, 'cli');
  });

  it('produces no stdout output (silent)', () => {
    ensureCollabDir(tmpDir);
    const out = runHook({ session_id: 'sess-1', cwd: tmpDir });
    assert.equal(out, '');
  });

  it('exits silently when no collab directory exists', () => {
    const { root: fsRoot } = path.parse(tmpDir);
    const isolated = path.join(fsRoot, '__mark_prompt_test_' + process.pid);
    fs.mkdirSync(isolated, { recursive: true });
    try {
      const out = runHook({ session_id: 'sess-1', cwd: isolated });
      assert.equal(out, '');
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('exits silently with no cwd', () => {
    const out = runHook({ session_id: 'sess-1' });
    assert.equal(out, '');
  });

  it('exits silently with no session_id', () => {
    const out = runHook({ cwd: tmpDir });
    assert.equal(out, '');
  });

  it('exits silently when session_id fails validateSessionId (e.g., reserved ID)', () => {
    const collabDir = ensureCollabDir(tmpDir);
    runHook({ session_id: 'wrightward:runtime', cwd: tmpDir });
    assert.equal(readMarker(collabDir, 'wrightward:runtime'), null);
  });

  it('does nothing when ENABLED is false', () => {
    const collabDir = ensureCollabDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.claude', 'wrightward.json'),
      JSON.stringify({ ENABLED: false }));
    runHook({ session_id: 'sess-1', cwd: tmpDir });
    assert.equal(readMarker(collabDir, 'sess-1'), null);
  });
});
