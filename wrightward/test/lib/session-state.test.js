'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { writeContext, readContext } = require('../../lib/context');
const { scavengeExpiredFiles, getAllClaimedFiles, isFileClaimedByAnySession } = require('../../lib/session-state');
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

    scavengeExpiredFiles(collabDir, config);
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

    scavengeExpiredFiles(collabDir, config);
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

    scavengeExpiredFiles(collabDir, config);
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

    scavengeExpiredFiles(collabDir, config);
    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.files.length, 0);
  });

  it('removes expired files from the current session too (long-running session cleanup)', () => {
    // Regression: previously scavengeExpiredFiles excluded the current session,
    // causing long-running sessions to accumulate stale auto-tracked file entries
    // that would never expire. This test mirrors what heartbeat.js does — it
    // passes the current session ID — and asserts stale entries still get cleaned.
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

    // heartbeat.js runs this unconditionally — the owning session's own entries
    // must be scavenged just like any other session's. Previously an excludeSessionId
    // argument caused the owning session to be skipped, which meant long-running
    // sessions accumulated stale entries indefinitely.
    scavengeExpiredFiles(collabDir, config);
    const ctx = readContext(collabDir, 'sess-1');
    assert.notEqual(ctx, null);
    assert.equal(ctx.files.length, 1, 'expected old.js to be scavenged from the owning session');
    assert.equal(ctx.files[0].path, 'recent.js');
  });

  it('does nothing when context directory is missing', () => {
    fs.rmSync(path.join(collabDir, 'context'), { recursive: true, force: true });
    assert.doesNotThrow(() => scavengeExpiredFiles(collabDir, config));
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

    scavengeExpiredFiles(collabDir, config);
    const ctx = readContext(collabDir, 'sess-1');
    assert.equal(ctx.files.length, 1);
  });
});

describe('getAllClaimedFiles', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-claims-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-A');
    registerAgent(collabDir, 'sess-B');
    writeContext(collabDir, 'sess-A', {
      task: 'a', status: 'in-progress',
      files: [
        { path: 'a1.js', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() },
        { path: 'a2.js', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }
      ]
    });
    writeContext(collabDir, 'sess-B', {
      task: 'b', status: 'in-progress',
      files: [
        { path: 'b1.js', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }
      ]
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns every claimed file when excludeSessionIds is empty/omitted', () => {
    withAgentsLock(collabDir, () => {
      const claims = getAllClaimedFiles(collabDir);
      assert.deepEqual([...claims].sort(), ['a1.js', 'a2.js', 'b1.js']);
    });
  });

  it('omits claims from sessions in excludeSessionIds (Array form)', () => {
    withAgentsLock(collabDir, () => {
      const claims = getAllClaimedFiles(collabDir, ['sess-A']);
      assert.deepEqual([...claims].sort(), ['b1.js']);
    });
  });

  it('omits claims from sessions in excludeSessionIds (Set form)', () => {
    withAgentsLock(collabDir, () => {
      const claims = getAllClaimedFiles(collabDir, new Set(['sess-A']));
      assert.deepEqual([...claims].sort(), ['b1.js']);
    });
  });

  it('skips entries with prefix "-" (deletions are not claims)', () => {
    writeContext(collabDir, 'sess-A', {
      task: 'a', status: 'in-progress',
      files: [
        { path: 'deleted.js', prefix: '-', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() },
        { path: 'a2.js', prefix: '~', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }
      ]
    });
    withAgentsLock(collabDir, () => {
      const claims = getAllClaimedFiles(collabDir);
      assert.ok(!claims.has('deleted.js'), 'prefix "-" should not count as a claim');
      assert.ok(claims.has('a2.js'));
    });
  });
});

describe('isFileClaimedByAnySession', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-isclaimed-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when at least one session claims the file', () => {
    registerAgent(collabDir, 'sess-A');
    writeContext(collabDir, 'sess-A', {
      task: 't', status: 'in-progress',
      files: [{ path: 'x.js', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }]
    });
    withAgentsLock(collabDir, () => {
      assert.equal(isFileClaimedByAnySession(collabDir, 'x.js'), true);
    });
  });

  it('returns false when no session claims the file', () => {
    registerAgent(collabDir, 'sess-A');
    writeContext(collabDir, 'sess-A', {
      task: 't', status: 'in-progress',
      files: [{ path: 'other.js', prefix: '+', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }]
    });
    withAgentsLock(collabDir, () => {
      assert.equal(isFileClaimedByAnySession(collabDir, 'x.js'), false);
    });
  });

  it('ignores entries with prefix "-"', () => {
    registerAgent(collabDir, 'sess-A');
    writeContext(collabDir, 'sess-A', {
      task: 't', status: 'in-progress',
      files: [{ path: 'x.js', prefix: '-', source: 'planned', declaredAt: Date.now(), lastTouched: Date.now() }]
    });
    withAgentsLock(collabDir, () => {
      assert.equal(isFileClaimedByAnySession(collabDir, 'x.js'), false);
    });
  });

  it('tolerates a malformed context file (returns false instead of throwing)', () => {
    registerAgent(collabDir, 'sess-A');
    fs.writeFileSync(path.join(collabDir, 'context', 'sess-A.json'), '{not json', 'utf8');
    withAgentsLock(collabDir, () => {
      assert.equal(isFileClaimedByAnySession(collabDir, 'x.js'), false);
    });
  });
});
