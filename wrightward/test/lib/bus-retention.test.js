'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { withAgentsLock } = require('../../lib/agents');
const { append, busPath } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');
const { compact, resetAllBookmarks } = require('../../lib/bus-retention');
const interestIndex = require('../../lib/interest-index');

describe('bus-retention', () => {
  let tmpDir;
  let collabDir;
  const config = { BUS_RETENTION_DAYS_MS: 0, BUS_RETENTION_MAX_EVENTS: 10000 };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-retention-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resetAllBookmarks error tolerance', () => {
    it('tolerates a malformed bookmark JSON during compact (other bookmarks still reset)', () => {
      const deliveredDir = path.join(collabDir, 'bus-delivered');

      // One good bookmark for sess-1.
      fs.writeFileSync(path.join(deliveredDir, 'sess-1.json'), JSON.stringify({
        lastDeliveredOffset: 100, lastScannedOffset: 200,
        lastDeliveredId: 'id-good', lastDeliveredTs: 5000, generation: 3
      }), 'utf8');

      // Corrupt bookmark for sess-2 — parse will throw.
      fs.writeFileSync(path.join(deliveredDir, 'sess-2.json'), '{not valid json', 'utf8');

      // Run compact — must NOT throw even though sess-2 fails to parse.
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'hi'));
        assert.doesNotThrow(() => compact(token, collabDir, config));
      });

      // sess-1 bookmark was reset: generation=-1 and offsets zeroed.
      const bm1 = JSON.parse(fs.readFileSync(path.join(deliveredDir, 'sess-1.json'), 'utf8'));
      assert.equal(bm1.lastDeliveredOffset, 0);
      assert.equal(bm1.lastScannedOffset, 0);
      assert.equal(bm1.generation, -1);
      // Preserved ts/id so readInboxFresh can still dedup by them.
      assert.equal(bm1.lastDeliveredId, 'id-good');
      assert.equal(bm1.lastDeliveredTs, 5000);
    });

    it('resetAllBookmarks is a no-op (no throw) when bus-delivered directory is missing', () => {
      // Delete bus-delivered to simulate the ENOENT branch.
      const deliveredDir = path.join(collabDir, 'bus-delivered');
      fs.rmSync(deliveredDir, { recursive: true, force: true });

      assert.doesNotThrow(() => resetAllBookmarks(collabDir));
    });
  });

  describe('compact ENOENT branch', () => {
    it('handles missing bus.jsonl by resetting meta without throwing', () => {
      withAgentsLock(collabDir, (token) => {
        // bus.jsonl doesn't exist yet — no append() call.
        const result = compact(token, collabDir, config,
          (t, dir) => interestIndex.rebuild(t, dir));
        assert.deepEqual(result, { before: 0, after: 0 });
      });

      // bus.jsonl stays missing; meta should exist with generation >= 1.
      assert.ok(!fs.existsSync(busPath(collabDir)));
      const meta = JSON.parse(fs.readFileSync(path.join(collabDir, 'bus-meta.json'), 'utf8'));
      assert.ok(meta.generation >= 1);
    });
  });
});
