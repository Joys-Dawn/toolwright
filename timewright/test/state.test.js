'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  getTimewrightRoot,
  getSnapshotDir,
  getStaleDir,
  getMetadataPath,
  ensureRoot,
  isStale,
  markStale,
  markFresh,
  readMetadata,
  writeMetadata
} = require('../lib/state');

const { makeTmpDir, cleanup } = require('./helpers');

describe('state', () => {
  let cwd;

  beforeEach(() => {
    cwd = makeTmpDir('tw-state-');
  });

  afterEach(() => {
    cleanup(cwd);
  });

  describe('path helpers', () => {
    it('getTimewrightRoot returns .claude/timewright under cwd', () => {
      const expected = path.join(cwd, '.claude', 'timewright');
      assert.equal(getTimewrightRoot(cwd), expected);
    });

    it('getSnapshotDir is nested under timewright root', () => {
      assert.equal(getSnapshotDir(cwd), path.join(cwd, '.claude', 'timewright', 'snapshot'));
    });

    it('getStaleDir is named stale.d to match the directory-based flag layout', () => {
      assert.equal(getStaleDir(cwd), path.join(cwd, '.claude', 'timewright', 'stale.d'));
    });

    it('getMetadataPath points to snapshot.json', () => {
      assert.equal(getMetadataPath(cwd), path.join(cwd, '.claude', 'timewright', 'snapshot.json'));
    });
  });

  describe('ensureRoot', () => {
    it('creates the timewright root directory on first call', () => {
      assert.equal(fs.existsSync(getTimewrightRoot(cwd)), false);
      ensureRoot(cwd);
      assert.equal(fs.existsSync(getTimewrightRoot(cwd)), true);
    });

    it('is idempotent — second call does not throw', () => {
      ensureRoot(cwd);
      assert.doesNotThrow(() => ensureRoot(cwd));
    });
  });

  describe('isStale', () => {
    it('returns true when no snapshot directory exists (fresh install)', () => {
      assert.equal(isStale(cwd), true);
    });

    it('returns false when snapshot exists and stale.d is empty', () => {
      fs.mkdirSync(getSnapshotDir(cwd), { recursive: true });
      assert.equal(isStale(cwd), false);
    });

    it('returns false when snapshot exists and stale.d directory is missing', () => {
      fs.mkdirSync(getSnapshotDir(cwd), { recursive: true });
      // stale.d has never been created
      assert.equal(fs.existsSync(getStaleDir(cwd)), false);
      assert.equal(isStale(cwd), false);
    });

    it('returns true when snapshot exists and stale.d has at least one marker', () => {
      fs.mkdirSync(getSnapshotDir(cwd), { recursive: true });
      markStale(cwd);
      assert.equal(isStale(cwd), true);
    });
  });

  describe('markStale', () => {
    it('creates a uniquely-named marker file under stale.d', () => {
      markStale(cwd);
      const entries = fs.readdirSync(getStaleDir(cwd));
      assert.equal(entries.length, 1);
    });

    it('is safe under sequential calls — each call adds a new marker, no overwrite', () => {
      markStale(cwd);
      markStale(cwd);
      markStale(cwd);
      const entries = fs.readdirSync(getStaleDir(cwd));
      assert.equal(entries.length, 3, 'three markStale calls should produce three distinct marker files');
    });

    it('marker filenames are unique even when called in tight sequence', () => {
      // Regression check: concurrent PostToolUse hooks on Windows must not
      // collide on the same stale-flag path. Uniqueness is the mechanism
      // that prevents the EBUSY/EACCES race described in the audit.
      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        markStale(cwd);
      }
      const entries = new Set(fs.readdirSync(getStaleDir(cwd)));
      assert.equal(entries.size, iterations,
        'every markStale call must produce a distinct filename');
    });
  });

  describe('markFresh', () => {
    it('removes all markers from stale.d', () => {
      markStale(cwd);
      markStale(cwd);
      markStale(cwd);
      assert.equal(fs.readdirSync(getStaleDir(cwd)).length, 3);

      markFresh(cwd);
      assert.equal(fs.readdirSync(getStaleDir(cwd)).length, 0);
    });

    it('does not throw when stale.d directory does not exist', () => {
      assert.equal(fs.existsSync(getStaleDir(cwd)), false);
      assert.doesNotThrow(() => markFresh(cwd));
    });

    it('is idempotent — calling twice has the same effect as once', () => {
      markStale(cwd);
      markFresh(cwd);
      assert.doesNotThrow(() => markFresh(cwd));
      assert.equal(isStale(cwd), true); // still no snapshot, so still stale
    });
  });

  describe('markStale / isStale / markFresh round trip', () => {
    it('properly cycles through stale states', () => {
      // Give it a snapshot dir so the "no snapshot => stale" fallback
      // doesn't dominate the test.
      fs.mkdirSync(getSnapshotDir(cwd), { recursive: true });

      assert.equal(isStale(cwd), false, 'fresh snapshot starts not stale');

      markStale(cwd);
      assert.equal(isStale(cwd), true, 'after markStale, should be stale');

      markFresh(cwd);
      assert.equal(isStale(cwd), false, 'after markFresh, should not be stale');
    });
  });

  describe('metadata', () => {
    it('readMetadata returns null when snapshot.json does not exist', () => {
      assert.equal(readMetadata(cwd), null);
    });

    it('writeMetadata + readMetadata round-trip preserves the object', () => {
      const meta = {
        createdAt: '2026-04-11T00:00:00.000Z',
        cwd,
        realRepoHead: 'abc1234',
        unbornHead: false,
        dirtyFileCount: 3
      };
      writeMetadata(cwd, meta);

      const read = readMetadata(cwd);
      assert.deepEqual(read, meta);
    });

    it('readMetadata returns null on malformed JSON instead of throwing', () => {
      ensureRoot(cwd);
      fs.writeFileSync(getMetadataPath(cwd), '{not valid json', 'utf8');
      assert.equal(readMetadata(cwd), null);
    });
  });
});
