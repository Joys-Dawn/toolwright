'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const busMeta = require('../../lib/bus-meta');

describe('bus-meta', () => {
  let collabDir;

  beforeEach(() => {
    collabDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-meta-test-'));
  });

  afterEach(() => {
    fs.rmSync(collabDir, { recursive: true, force: true });
  });

  describe('readMeta', () => {
    it('returns zero-shape when file is missing (ENOENT)', () => {
      const meta = busMeta.readMeta(collabDir);
      assert.deepEqual(meta, { generation: 0, eventCount: 0, lastTs: 0 });
    });

    it('returns zero-shape on non-ENOENT read error', () => {
      // Replace file with a directory so readFileSync throws EISDIR
      fs.mkdirSync(busMeta.metaPath(collabDir), { recursive: true });
      const origWrite = process.stderr.write;
      process.stderr.write = () => true; // suppress expected log noise
      try {
        const meta = busMeta.readMeta(collabDir);
        assert.deepEqual(meta, { generation: 0, eventCount: 0, lastTs: 0 });
      } finally {
        process.stderr.write = origWrite;
        fs.rmdirSync(busMeta.metaPath(collabDir));
      }
    });

    it('returns CORRUPT_GENERATION sentinel on parse error', () => {
      fs.writeFileSync(busMeta.metaPath(collabDir), 'not json', 'utf8');
      const origWrite = process.stderr.write;
      process.stderr.write = () => true; // suppress expected log noise
      try {
        const meta = busMeta.readMeta(collabDir);
        // Sentinel is -1 — distinct from fresh-file 0 so every bookmark is stale.
        assert.equal(meta.generation, -1);
        assert.equal(meta.eventCount, 0);
        assert.equal(meta.lastTs, 0);
      } finally {
        process.stderr.write = origWrite;
      }
    });

    it('roundtrips valid content', () => {
      busMeta.writeMeta(collabDir, { generation: 3, eventCount: 42, lastTs: 12345 });
      const meta = busMeta.readMeta(collabDir);
      assert.deepEqual(meta, { generation: 3, eventCount: 42, lastTs: 12345 });
    });

    it('coerces missing fields to zero-shape', () => {
      fs.writeFileSync(busMeta.metaPath(collabDir), '{}', 'utf8');
      const meta = busMeta.readMeta(collabDir);
      assert.deepEqual(meta, { generation: 0, eventCount: 0, lastTs: 0 });
    });

    it('coerces non-numeric fields to 0', () => {
      fs.writeFileSync(busMeta.metaPath(collabDir),
        JSON.stringify({ generation: 'oops', eventCount: null, lastTs: {} }), 'utf8');
      const meta = busMeta.readMeta(collabDir);
      assert.deepEqual(meta, { generation: 0, eventCount: 0, lastTs: 0 });
    });
  });

  describe('incrementEventCount', () => {
    it('increments from missing file to n', () => {
      const newCount = busMeta.incrementEventCount(collabDir, 3, 1000);
      assert.equal(newCount, 3);
      const meta = busMeta.readMeta(collabDir);
      assert.equal(meta.eventCount, 3);
      assert.equal(meta.lastTs, 1000);
    });

    it('accumulates across calls', () => {
      busMeta.incrementEventCount(collabDir, 2, 100);
      busMeta.incrementEventCount(collabDir, 5, 200);
      assert.equal(busMeta.readMeta(collabDir).eventCount, 7);
    });

    it('preserves max lastTs — never regresses', () => {
      busMeta.incrementEventCount(collabDir, 1, 500);
      busMeta.incrementEventCount(collabDir, 1, 200); // older ts
      assert.equal(busMeta.readMeta(collabDir).lastTs, 500);
    });

    it('defaults n to 1 when omitted', () => {
      busMeta.incrementEventCount(collabDir, undefined, 100);
      assert.equal(busMeta.readMeta(collabDir).eventCount, 1);
    });

    it('ignores non-numeric lastTs', () => {
      busMeta.incrementEventCount(collabDir, 1, 'not a ts');
      assert.equal(busMeta.readMeta(collabDir).lastTs, 0);
    });
  });

  describe('onCompact', () => {
    it('bumps generation from 0 to 1 and resets event count', () => {
      const gen = busMeta.onCompact(collabDir, 50, 999);
      assert.equal(gen, 1);
      const meta = busMeta.readMeta(collabDir);
      assert.equal(meta.generation, 1);
      assert.equal(meta.eventCount, 50);
      assert.equal(meta.lastTs, 999);
    });

    it('bumps generation from N to N+1', () => {
      busMeta.writeMeta(collabDir, { generation: 7, eventCount: 10, lastTs: 100 });
      const gen = busMeta.onCompact(collabDir, 5, 200);
      assert.equal(gen, 8);
      assert.equal(busMeta.readMeta(collabDir).generation, 8);
    });

    it('recovers from CORRUPT_GENERATION sentinel — bumps -1 to >=1 so no bookmark silently matches', () => {
      fs.writeFileSync(busMeta.metaPath(collabDir), 'corrupt', 'utf8');
      // readMeta returns -1 sentinel; onCompact must clamp to 0 before +1 so
      // that the post-compact generation is at least 1 (distinct from the
      // fresh-file 0 that new bookmarks hold). Otherwise bookmarks with
      // generation 0 would spuriously match and skip the safe rescan.
      const origWrite = process.stderr.write;
      process.stderr.write = () => true;
      try {
        const gen = busMeta.onCompact(collabDir, 3, 500);
        assert.ok(gen >= 1, 'post-compact generation must be >= 1');
      } finally {
        process.stderr.write = origWrite;
      }
      const meta = busMeta.readMeta(collabDir);
      assert.ok(meta.generation >= 1);
      assert.equal(meta.eventCount, 3);
    });

    it('preserves lastTs when newLastTs is undefined', () => {
      busMeta.writeMeta(collabDir, { generation: 1, eventCount: 5, lastTs: 777 });
      busMeta.onCompact(collabDir, 2);
      assert.equal(busMeta.readMeta(collabDir).lastTs, 777);
    });
  });

});
