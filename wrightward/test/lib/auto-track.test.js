'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { writeContext, readContext } = require('../../lib/context');
const { autoTrackFile } = require('../../lib/auto-track');

describe('autoTrackFile', () => {
  let cwd;
  let collabDir;
  const sessionId = 'sess-1';

  // Baseline config — individual tests override fields as needed.
  const baseConfig = {
    AUTO_TRACK: true,
    REMINDER_IDLE_MS: 5 * 60 * 1000
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-track-test-'));
    collabDir = ensureCollabDir(cwd);
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe('context creation', () => {
    it('creates a minimal context when none exists and AUTO_TRACK is true', () => {
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'src/a.ts'), baseConfig, false);
      const ctx = readContext(collabDir, sessionId);
      assert.ok(ctx);
      assert.equal(ctx.status, 'in-progress');
      assert.equal(ctx.files.length, 1);
      assert.equal(ctx.files[0].path, 'src/a.ts');
    });

    it('does NOT create a context when AUTO_TRACK is false and none exists', () => {
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'src/a.ts'),
        { ...baseConfig, AUTO_TRACK: false }, false);
      assert.equal(readContext(collabDir, sessionId), null);
    });

    it('DOES track files into an existing context even when AUTO_TRACK is false', () => {
      writeContext(collabDir, sessionId, {
        task: 'existing',
        files: [],
        status: 'in-progress'
      });
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'src/a.ts'),
        { ...baseConfig, AUTO_TRACK: false }, false);
      const ctx = readContext(collabDir, sessionId);
      assert.equal(ctx.files.length, 1);
      assert.equal(ctx.files[0].path, 'src/a.ts');
    });
  });

  describe('path handling', () => {
    it('uses ~ prefix for Edit', () => {
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'a.ts'), baseConfig, false);
      const ctx = readContext(collabDir, sessionId);
      assert.equal(ctx.files[0].prefix, '~');
    });

    it('uses + prefix for Write', () => {
      autoTrackFile(collabDir, sessionId, cwd, 'Write', path.join(cwd, 'a.ts'), baseConfig, false);
      const ctx = readContext(collabDir, sessionId);
      assert.equal(ctx.files[0].prefix, '+');
    });

    it('converts native path separators to POSIX in stored path', () => {
      autoTrackFile(collabDir, sessionId, cwd, 'Edit',
        path.join(cwd, 'src', 'nested', 'file.ts'), baseConfig, false);
      const ctx = readContext(collabDir, sessionId);
      assert.equal(ctx.files[0].path, 'src/nested/file.ts');
    });

    it('skips files outside cwd (relative starts with ..)', () => {
      const outside = path.resolve(cwd, '..', 'other.ts');
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', outside, baseConfig, false);
      const ctx = readContext(collabDir, sessionId);
      assert.equal(ctx.files.length, 0);
    });

    it('updates lastTouched and resets reminded on repeat tracking', () => {
      const filePath = path.join(cwd, 'a.ts');
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', filePath, baseConfig, false);

      // Capture first-touch state, then mark as reminded to simulate an
      // earlier reminder pass and set lastTouched into the past.
      const firstCtx = readContext(collabDir, sessionId);
      const firstTouch = firstCtx.files[0].lastTouched;
      const pastTouch = firstTouch - 60 * 1000;
      firstCtx.files[0].reminded = true;
      firstCtx.files[0].lastTouched = pastTouch;
      writeContext(collabDir, sessionId, firstCtx);

      autoTrackFile(collabDir, sessionId, cwd, 'Edit', filePath, baseConfig, false);

      const updated = readContext(collabDir, sessionId);
      assert.equal(updated.files.length, 1, 'no duplicate entry');
      assert.equal(updated.files[0].reminded, false);
      assert.ok(updated.files[0].lastTouched > pastTouch,
        'lastTouched must advance past the simulated old value');
    });
  });

  describe('idle reminders', () => {
    it('returns null when hasOtherAgents is false (no reminders possible)', () => {
      const filePath = path.join(cwd, 'a.ts');
      writeContext(collabDir, sessionId, {
        task: 't',
        files: [{ path: 'a.ts', prefix: '~', source: 'auto',
          declaredAt: 1000, lastTouched: 1000, reminded: false }],
        status: 'in-progress'
      });
      const result = autoTrackFile(collabDir, sessionId, cwd, 'Edit', filePath, baseConfig, false);
      assert.equal(result, null);
    });

    // Use a wide idle window so the file we touch inside the call (lastTouched ≈ now)
    // never qualifies as idle — only pre-seeded entries with old lastTouched do.
    const WIDE_IDLE_MS = 60 * 1000;

    it('does NOT flag reminded when hasOtherAgents is false', () => {
      writeContext(collabDir, sessionId, {
        task: 't',
        files: [{ path: 'idle.ts', prefix: '~', source: 'auto',
          declaredAt: 1000, lastTouched: 1000, reminded: false }],
        status: 'in-progress'
      });
      autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'new.ts'),
        { ...baseConfig, REMINDER_IDLE_MS: WIDE_IDLE_MS }, false);
      const ctx = readContext(collabDir, sessionId);
      const idle = ctx.files.find(f => f.path === 'idle.ts');
      assert.equal(idle.reminded, false,
        'reminded flag must remain false when no other agents are active');
    });

    it('returns and flags idle files when hasOtherAgents is true', () => {
      writeContext(collabDir, sessionId, {
        task: 't',
        files: [{ path: 'idle.ts', prefix: '~', source: 'auto',
          declaredAt: 1000, lastTouched: 1000, reminded: false }],
        status: 'in-progress'
      });
      const result = autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'new.ts'),
        { ...baseConfig, REMINDER_IDLE_MS: WIDE_IDLE_MS }, true);
      assert.deepEqual(result, ['idle.ts']);
      const ctx = readContext(collabDir, sessionId);
      const idle = ctx.files.find(f => f.path === 'idle.ts');
      assert.equal(idle.reminded, true);
    });

    it('does not return already-reminded files', () => {
      writeContext(collabDir, sessionId, {
        task: 't',
        files: [{ path: 'old.ts', prefix: '~', source: 'auto',
          declaredAt: 1000, lastTouched: 1000, reminded: true }],
        status: 'in-progress'
      });
      const result = autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'new.ts'),
        { ...baseConfig, REMINDER_IDLE_MS: WIDE_IDLE_MS }, true);
      assert.equal(result, null);
    });

    it('does not return files without lastTouched (e.g., planned w/ no activity)', () => {
      writeContext(collabDir, sessionId, {
        task: 't',
        files: [{ path: 'never.ts', prefix: '~', source: 'planned',
          declaredAt: 1000, reminded: false }],
        status: 'in-progress'
      });
      const result = autoTrackFile(collabDir, sessionId, cwd, 'Edit', path.join(cwd, 'new.ts'),
        { ...baseConfig, REMINDER_IDLE_MS: WIDE_IDLE_MS }, true);
      assert.equal(result, null);
    });
  });
});
