'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { registerAgent, withAgentsLock } = require('../../lib/agents');
const { append, readBookmark, writeBookmark } = require('../../lib/bus-log');
const { createEvent } = require('../../lib/bus-schema');
const { scanAndFormatInbox, readInboxFresh, advanceBookmark } = require('../../lib/bus-delivery');

describe('bus-delivery', () => {
  let tmpDir;
  let collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-delivery-'));
    collabDir = ensureCollabDir(tmpDir);
    registerAgent(collabDir, 'sess-1');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('scanAndFormatInbox', () => {
    it('returns formatted text for urgent events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'take this over'));

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.ok(result.text);
        assert.ok(result.text.includes('Urgent messages'));
        assert.ok(result.text.includes('take this over'));
        assert.equal(result.eventCount, 1);
      });
    });

    it('returns null when no urgent events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'not urgent'));

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.equal(result.text, null);
        assert.equal(result.eventCount, 0);
      });
    });

    it('advances bookmark after delivery', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg'));
        scanAndFormatInbox(token, collabDir, 'sess-1', {});
      });

      const bm = readBookmark(collabDir, 'sess-1');
      assert.ok(bm.lastDeliveredOffset > 0);
      assert.ok(bm.lastScannedOffset > 0);
    });

    it('advances scanned offset even with no urgent events', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'note', 'hi'));
        scanAndFormatInbox(token, collabDir, 'sess-1', {});
      });

      const bm = readBookmark(collabDir, 'sess-1');
      assert.equal(bm.lastDeliveredOffset, 0);
      assert.ok(bm.lastScannedOffset > 0);
    });

    it('caps events at BUS_URGENT_INJECTION_CAP', () => {
      withAgentsLock(collabDir, (token) => {
        for (let i = 0; i < 10; i++) {
          append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg-' + i));
        }

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', { BUS_URGENT_INJECTION_CAP: 3 });
        assert.ok(result.text);
        assert.equal(result.eventCount, 10);
        assert.ok(result.text.includes('7 more'));
      });
    });

    it('does not re-deliver events on second call', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'once'));
        const first = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.ok(first.text);

        const second = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.equal(second.text, null);
      });
    });

    it('preserves un-delivered tail when events overflow cap', () => {
      withAgentsLock(collabDir, (token) => {
        for (let i = 0; i < 7; i++) {
          append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'msg-' + i));
        }

        const first = scanAndFormatInbox(token, collabDir, 'sess-1', { BUS_URGENT_INJECTION_CAP: 3 });
        assert.ok(first.text.includes('msg-0'));
        assert.ok(first.text.includes('msg-2'));
        assert.ok(!first.text.includes('msg-3'), 'msg-3 is beyond cap, should not appear in first call');
        assert.equal(first.eventCount, 7);

        const second = scanAndFormatInbox(token, collabDir, 'sess-1', { BUS_URGENT_INJECTION_CAP: 3 });
        assert.ok(second.text, 'second call must still have events');
        assert.ok(second.text.includes('msg-3'), 'msg-3 (tail) must re-surface');
        assert.ok(!second.text.includes('msg-0'), 'msg-0 was delivered, must not re-appear');
      });
    });

    it('handles bookmark staleness after compaction via generation counter', () => {
      const { compact } = require('../../lib/bus-retention');
      const interestIndex = require('../../lib/interest-index');

      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'before-compact'));
        scanAndFormatInbox(token, collabDir, 'sess-1', {});

        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'after-compact'));
        compact(token, collabDir, { BUS_RETENTION_DAYS_MS: 0, BUS_RETENTION_MAX_EVENTS: 10000 },
          (t, dir) => interestIndex.rebuild(t, dir));

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.ok(result.text, 'post-compact scan should deliver new events');
        assert.ok(result.text.includes('after-compact'));
        assert.ok(!result.text.includes('before-compact'), 'already-delivered events must not re-appear after compact');
      });
    });
  });

  describe('readInboxFresh', () => {
    it('returns events and marks isStale=false when bookmark generation matches meta', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'm'));
        const result = readInboxFresh(token, collabDir, 'sess-1');
        assert.equal(result.isStale, false);
        assert.equal(result.events.length, 1);
        assert.ok(result.endOffset > 0);
      });
    });

    it('marks isStale=true and rescans from offset 0 when bookmark.generation mismatches meta.generation', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'm'));
        // Write a bookmark whose generation does NOT match meta (meta.generation==0 for fresh bus).
        writeBookmark(token, collabDir, 'sess-1', {
          lastDeliveredOffset: 0,
          lastScannedOffset: 9999,   // would otherwise skip the event
          lastDeliveredId: '',
          lastDeliveredTs: 0,
          generation: 42
        });
        const result = readInboxFresh(token, collabDir, 'sess-1');
        assert.equal(result.isStale, true);
        assert.equal(result.events.length, 1, 'stale bookmark should force a full rescan and re-surface the event');
      });
    });

    it('ts+id dedup filters the already-delivered event but keeps same-ts sibling with different id', () => {
      withAgentsLock(collabDir, (token) => {
        // Fix ts so both events share it; ids are distinct.
        const sharedTs = Date.now();
        const e1 = { ...createEvent('sess-2', 'sess-1', 'handoff', 'first'), ts: sharedTs };
        const e2 = { ...createEvent('sess-2', 'sess-1', 'handoff', 'second'), ts: sharedTs };
        append(token, collabDir, e1);
        append(token, collabDir, e2);

        // Mark e1 as delivered; leave lastScannedOffset behind lastDeliveredOffset
        // so needsDedup fires via the lastScannedOffset<=lastDeliveredOffset branch.
        writeBookmark(token, collabDir, 'sess-1', {
          lastDeliveredOffset: 100,
          lastScannedOffset: 0,
          lastDeliveredId: e1.id,
          lastDeliveredTs: sharedTs,
          generation: 0
        });

        const result = readInboxFresh(token, collabDir, 'sess-1');
        assert.equal(result.events.length, 1, 'e1 should be dedup filtered, e2 kept');
        assert.equal(result.events[0].id, e2.id);
      });
    });

    it('applies dedup when lastScannedOffset<=lastDeliveredOffset even when not stale (types-filter re-read case)', () => {
      withAgentsLock(collabDir, (token) => {
        const e1 = createEvent('sess-2', 'sess-1', 'handoff', 'already-seen');
        append(token, collabDir, e1);

        // Simulate the types-filter re-read bookmark: lastScannedOffset held
        // behind lastDeliveredOffset so the caller can re-read filtered events,
        // with ts/id dedup expected to drop the already-delivered one.
        writeBookmark(token, collabDir, 'sess-1', {
          lastDeliveredOffset: 100,
          lastScannedOffset: 0,
          lastDeliveredId: e1.id,
          lastDeliveredTs: e1.ts,
          generation: 0
        });

        const result = readInboxFresh(token, collabDir, 'sess-1');
        assert.equal(result.isStale, false);
        assert.equal(result.events.length, 0, 'e1 must be filtered via ts+id dedup despite not being stale');
      });
    });
  });

  describe('advanceBookmark', () => {
    it('is a no-op when nothing moved (no delivery, not stale, endOffset unchanged)', () => {
      withAgentsLock(collabDir, (token) => {
        const frozen = {
          lastDeliveredOffset: 50,
          lastScannedOffset: 200,
          lastDeliveredId: 'id-x',
          lastDeliveredTs: 123456,
          generation: 0
        };
        writeBookmark(token, collabDir, 'sess-1', frozen);
        advanceBookmark(token, collabDir, 'sess-1', {
          delivered: null,
          endOffset: 200,
          bookmark: frozen,
          meta: { generation: 0 },
          isStale: false,
          truncated: false
        });
        assert.deepEqual(readBookmark(collabDir, 'sess-1'), frozen);
      });
    });

    it('pins lastScannedOffset to delivered._offset when truncated (overflow cap)', () => {
      withAgentsLock(collabDir, (token) => {
        const prior = {
          lastDeliveredOffset: 0, lastScannedOffset: 0,
          lastDeliveredId: '', lastDeliveredTs: 0, generation: 0
        };
        const delivered = { _offset: 100, id: 'd1', ts: 5000 };
        advanceBookmark(token, collabDir, 'sess-1', {
          delivered,
          endOffset: 400,
          bookmark: prior,
          meta: { generation: 0 },
          isStale: false,
          truncated: true
        });
        const bm = readBookmark(collabDir, 'sess-1');
        assert.equal(bm.lastDeliveredOffset, 100);
        assert.equal(bm.lastScannedOffset, 100, 'truncated path must pin scanned to delivered._offset');
        assert.equal(bm.lastDeliveredId, 'd1');
        assert.equal(bm.lastDeliveredTs, 5000);
      });
    });

    it('advances lastScannedOffset to endOffset and preserves lastDeliveredOffset on scan-only tick', () => {
      withAgentsLock(collabDir, (token) => {
        const prior = {
          lastDeliveredOffset: 42, lastScannedOffset: 50,
          lastDeliveredId: 'keep', lastDeliveredTs: 999, generation: 0
        };
        writeBookmark(token, collabDir, 'sess-1', prior);
        advanceBookmark(token, collabDir, 'sess-1', {
          delivered: null,
          endOffset: 300,
          bookmark: prior,
          meta: { generation: 0 },
          isStale: false,
          truncated: false
        });
        const bm = readBookmark(collabDir, 'sess-1');
        assert.equal(bm.lastScannedOffset, 300, 'scan cursor should advance');
        assert.equal(bm.lastDeliveredOffset, 42, 'lastDeliveredOffset must be preserved on scan-only tick');
        assert.equal(bm.lastDeliveredId, 'keep');
        assert.equal(bm.lastDeliveredTs, 999);
      });
    });
  });
});
