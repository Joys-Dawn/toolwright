'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { withAgentsLock, assertLockHeld } = require('../../lib/agents');
const { createEvent } = require('../../lib/bus-schema');
const { append, appendBatch, tailReader, readBookmark, writeBookmark, deleteBookmark, busPath } = require('../../lib/bus-log');
const { compact } = require('../../lib/bus-retention');

describe('bus-log', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-log-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEvent(type, from, to) {
    return createEvent(from || 'sess-1', to || 'all', type || 'note', 'test body');
  }

  describe('append', () => {
    it('creates bus.jsonl if missing', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, makeEvent());
      });
      const p = busPath(collabDir);
      assert.ok(fs.existsSync(p));
      const content = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.type, 'note');
    });

    it('returns new file size', () => {
      let size;
      withAgentsLock(collabDir, (token) => {
        size = append(token, collabDir, makeEvent());
      });
      const actual = fs.statSync(busPath(collabDir)).size;
      assert.equal(size, actual);
    });

    it('appends multiple events sequentially', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, makeEvent('note'));
        append(token, collabDir, makeEvent('finding'));
      });
      const lines = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).type, 'note');
      assert.equal(JSON.parse(lines[1]).type, 'finding');
    });
  });

  describe('appendBatch', () => {
    it('writes multiple events in one call', () => {
      const events = [makeEvent('note'), makeEvent('finding'), makeEvent('decision')];
      withAgentsLock(collabDir, (token) => {
        appendBatch(token, collabDir, events);
      });
      const lines = fs.readFileSync(busPath(collabDir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
      assert.equal(JSON.parse(lines[0]).type, 'note');
      assert.equal(JSON.parse(lines[1]).type, 'finding');
      assert.equal(JSON.parse(lines[2]).type, 'decision');
    });

    it('returns correct file size', () => {
      const events = [makeEvent(), makeEvent()];
      let size;
      withAgentsLock(collabDir, (token) => {
        size = appendBatch(token, collabDir, events);
      });
      const actual = fs.statSync(busPath(collabDir)).size;
      assert.equal(size, actual);
    });

    it('handles empty array', () => {
      withAgentsLock(collabDir, (token) => {
        const size = appendBatch(token, collabDir, []);
        assert.equal(size, 0);
      });
    });
  });

  describe('tailReader', () => {
    it('reads all events from offset 0', () => {
      const events = [makeEvent('note'), makeEvent('finding')];
      withAgentsLock(collabDir, (token) => {
        appendBatch(token, collabDir, events);
        const result = tailReader(token, collabDir, 0);
        assert.equal(result.events.length, 2);
        assert.equal(result.endOffset, fs.statSync(busPath(collabDir)).size);
      });
    });

    it('reads events from mid-file offset', () => {
      let firstSize;
      withAgentsLock(collabDir, (token) => {
        firstSize = append(token, collabDir, makeEvent('note'));
        append(token, collabDir, makeEvent('finding'));
      });
      withAgentsLock(collabDir, (token) => {
        const result = tailReader(token, collabDir, firstSize);
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].type, 'finding');
      });
    });

    it('returns empty for missing file', () => {
      withAgentsLock(collabDir, (token) => {
        const result = tailReader(token, collabDir, 0);
        assert.deepEqual(result.events, []);
        assert.equal(result.endOffset, 0);
      });
    });

    it('returns empty for empty file', () => {
      fs.writeFileSync(busPath(collabDir), '', 'utf8');
      withAgentsLock(collabDir, (token) => {
        const result = tailReader(token, collabDir, 0);
        assert.deepEqual(result.events, []);
        assert.equal(result.endOffset, 0);
      });
    });

    it('handles fromOffset > fileSize (compaction self-correction)', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, makeEvent());
      });
      const fileSize = fs.statSync(busPath(collabDir)).size;
      withAgentsLock(collabDir, (token) => {
        const result = tailReader(token, collabDir, fileSize + 1000);
        assert.deepEqual(result.events, []);
        assert.equal(result.endOffset, fileSize);
      });
    });

    it('skips malformed lines', () => {
      const p = busPath(collabDir);
      const goodEvent = makeEvent();
      fs.writeFileSync(p, JSON.stringify(goodEvent) + '\n' + 'not-json\n', 'utf8');
      withAgentsLock(collabDir, (token) => {
        const result = tailReader(token, collabDir, 0);
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].type, 'note');
      });
    });

    it('preserves append order for same-ms events', () => {
      withAgentsLock(collabDir, (token) => {
        const a = makeEvent('note');
        const b = makeEvent('finding');
        a.ts = 1000;
        b.ts = 1000;
        append(token, collabDir, a);
        append(token, collabDir, b);
        const result = tailReader(token, collabDir, 0);
        assert.equal(result.events[0].type, 'note');
        assert.equal(result.events[1].type, 'finding');
      });
    });

    it('attaches _offset to each event', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, makeEvent());
        append(token, collabDir, makeEvent());
        const result = tailReader(token, collabDir, 0);
        for (const e of result.events) {
          assert.ok(typeof e._offset === 'number');
          assert.ok(e._offset > 0);
        }
        assert.ok(result.events[1]._offset > result.events[0]._offset);
      });
    });

    it('handles trailing newline without phantom event', () => {
      const e = makeEvent();
      fs.writeFileSync(busPath(collabDir), JSON.stringify(e) + '\n', 'utf8');
      withAgentsLock(collabDir, (token) => {
        const result = tailReader(token, collabDir, 0);
        assert.equal(result.events.length, 1);
      });
    });
  });

  describe('bookmark', () => {
    it('returns zero-shape for missing file', () => {
      const bm = readBookmark(collabDir, 'sess-1');
      assert.deepEqual(bm, {
        lastDeliveredOffset: 0,
        lastScannedOffset: 0,
        lastDeliveredId: '',
        lastDeliveredTs: 0
      });
    });

    it('roundtrips write and read', () => {
      const bookmark = {
        lastDeliveredOffset: 1234,
        lastScannedOffset: 5678,
        lastDeliveredId: 'abc-123',
        lastDeliveredTs: Date.now()
      };
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, 'sess-1', bookmark);
      });
      const read = readBookmark(collabDir, 'sess-1');
      assert.deepEqual(read, bookmark);
    });

    it('deleteBookmark removes file', () => {
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, 'sess-1', { lastDeliveredOffset: 1 });
      });
      deleteBookmark(collabDir, 'sess-1');
      const bm = readBookmark(collabDir, 'sess-1');
      assert.equal(bm.lastDeliveredOffset, 0);
    });

    it('deleteBookmark on missing file does not throw', () => {
      assert.doesNotThrow(() => deleteBookmark(collabDir, 'nonexistent'));
    });
  });

  describe('compact', () => {
    it('removes old events by age', () => {
      withAgentsLock(collabDir, (token) => {
        const old = makeEvent();
        old.ts = Date.now() - 10 * 24 * 60 * 60 * 1000;
        append(token, collabDir, old);
        const recent = makeEvent('finding');
        append(token, collabDir, recent);

        const result = compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 7 * 24 * 60 * 60 * 1000, BUS_RETENTION_MAX_EVENTS: 10000 });
        assert.equal(result.before, 2);
        assert.equal(result.after, 1);

        const remaining = tailReader(token, collabDir, 0);
        assert.equal(remaining.events.length, 1);
        assert.equal(remaining.events[0].type, 'finding');
      });
    });

    it('caps by max event count', () => {
      withAgentsLock(collabDir, (token) => {
        for (let i = 0; i < 5; i++) {
          append(token, collabDir, makeEvent());
        }
        const result = compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 0, BUS_RETENTION_MAX_EVENTS: 3 });
        assert.equal(result.before, 5);
        assert.equal(result.after, 3);
      });
    });

    it('preserves recent events', () => {
      withAgentsLock(collabDir, (token) => {
        const e = makeEvent();
        append(token, collabDir, e);
        const result = compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 7 * 24 * 60 * 60 * 1000, BUS_RETENTION_MAX_EVENTS: 10000 });
        assert.equal(result.after, 1);
      });
    });

    it('calls rebuildInterestIndex after compaction', () => {
      let called = false;
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, makeEvent());
        compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 0, BUS_RETENTION_MAX_EVENTS: 10000 }, () => { called = true; });
      });
      assert.ok(called);
    });

    it('resets bookmark offsets but preserves ts/id for dedup, and marks generation stale', () => {
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, 'sess-1', { lastDeliveredOffset: 9999, lastScannedOffset: 9999, lastDeliveredId: 'evt-x', lastDeliveredTs: 12345 });
        append(token, collabDir, makeEvent());
        compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 0, BUS_RETENTION_MAX_EVENTS: 10000 });
      });
      const bm = readBookmark(collabDir, 'sess-1');
      assert.equal(bm.lastDeliveredOffset, 0, 'offsets must reset (stale after rewrite)');
      assert.equal(bm.lastScannedOffset, 0, 'offsets must reset (stale after rewrite)');
      assert.equal(bm.lastDeliveredId, 'evt-x', 'id must be preserved for dedup');
      assert.equal(bm.lastDeliveredTs, 12345, 'ts must be preserved for dedup');
      // Sentinel -1 so bus-delivery always treats this bookmark as stale
      // against any post-compact meta.generation (>= 1).
      assert.equal(bm.generation, -1, 'generation sentinel must mark bookmark stale after compact');
    });

    it('handles missing bus file', () => {
      withAgentsLock(collabDir, (token) => {
        const result = compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 0, BUS_RETENTION_MAX_EVENTS: 10000 });
        assert.equal(result.before, 0);
        assert.equal(result.after, 0);
      });
    });
  });
});
