'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { scavengeExpiredFiles } = require('../../lib/session-state');
const { loadConfig } = require('../../lib/config');

describe('scavengeExpiredFiles', () => {
  let tmpDir;
  let collabDir;
  // loadConfig with a nonexistent cwd returns defaults converted to ms.
  const config = loadConfig('');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-scav-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes auto-tracked files past AUTO_TRACKED_FILE_TIMEOUT_MS', () => {
    registerAgent(collabDir, 'sess-1');
    const oldTime = Date.now() - config.AUTO_TRACKED_FILE_TIMEOUT_MS - 1000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false },
        { path: 'recent.js', prefix: '~', source: 'auto', declaredAt: Date.now(), lastTouched: Date.now(), reminded: false }
      ],
      status: 'in-progress'
    });

    scavengeExpiredFiles(collabDir, config, 'other-session');
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'recent.js');
  });

  it('removes planned files past PLANNED_FILE_TIMEOUT_MS when not recently touched', () => {
    registerAgent(collabDir, 'sess-1');
    const declaredLongAgo = Date.now() - config.PLANNED_FILE_TIMEOUT_MS - 1000;
    const touchedLongAgo = declaredLongAgo + 1000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old-planned.js', prefix: '+', source: 'planned', declaredAt: declaredLongAgo, lastTouched: touchedLongAgo, reminded: false }
      ],
      status: 'in-progress'
    });

    scavengeExpiredFiles(collabDir, config, 'other-session');
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 0);
  });

  it('extends planned file timeout if recently touched (grace period)', () => {
    registerAgent(collabDir, 'sess-1');
    const declaredLongAgo = Date.now() - config.PLANNED_FILE_TIMEOUT_MS - 1000;
    const touchedJustNow = Date.now() - 1000; // within grace period
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'active-planned.js', prefix: '+', source: 'planned', declaredAt: declaredLongAgo, lastTouched: touchedJustNow, reminded: false }
      ],
      status: 'in-progress'
    });

    scavengeExpiredFiles(collabDir, config, 'other-session');
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, 'active-planned.js');
  });

  it('keeps context with empty files when all files expire', () => {
    registerAgent(collabDir, 'sess-1');
    const oldTime = Date.now() - config.AUTO_TRACKED_FILE_TIMEOUT_MS - 1000;
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false }
      ],
      status: 'in-progress'
    });

    scavengeExpiredFiles(collabDir, config, 'other-session');
    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.files.length, 0);
  });

  it('skips the excluded session', () => {
    registerAgent(collabDir, 'sess-1');
    const oldTime = Date.now() - config.AUTO_TRACKED_FILE_TIMEOUT_MS - 1000;
    writeContext(collabDir, 'sess-1', {
      task: null,
      files: [
        { path: 'old.js', prefix: '~', source: 'auto', declaredAt: oldTime, lastTouched: oldTime, reminded: false }
      ],
      status: 'in-progress'
    });

    scavengeExpiredFiles(collabDir, config, 'sess-1');
    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.files.length, 1);
  });

  it('does nothing when context directory is missing', () => {
    fs.rmSync(path.join(collabDir, 'context'), { recursive: true, force: true });
    assert.doesNotThrow(() => scavengeExpiredFiles(collabDir, config, 'sess-1'));
  });

  it('keeps planned files within timeout', () => {
    registerAgent(collabDir, 'sess-1');
    const recentDeclare = Date.now() - 60000; // 1 minute ago, well within 15 min
    writeContext(collabDir, 'sess-1', {
      task: 'my work',
      files: [
        { path: 'fresh.js', prefix: '+', source: 'planned', declaredAt: recentDeclare, lastTouched: recentDeclare, reminded: false }
      ],
      status: 'in-progress'
    });

    scavengeExpiredFiles(collabDir, config, 'other-session');
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
  });
});
