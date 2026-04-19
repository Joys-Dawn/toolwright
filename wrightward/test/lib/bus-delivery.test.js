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
const { scanAndFormatInbox, readInboxFresh, advanceBookmark, formatEventLine, hintForType } = require('../../lib/bus-delivery');
const { deriveHandle } = require('../../lib/handles');

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
        assert.match(result.text, /Urgent messages/);
        assert.match(result.text, /take this over/);
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
        assert.match(result.text, /7 more/);
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
        assert.match(first.text, /msg-0/);
        assert.match(first.text, /msg-2/);
        assert.doesNotMatch(first.text, /msg-3/, 'msg-3 is beyond cap, should not appear in first call');
        assert.equal(first.eventCount, 7);

        const second = scanAndFormatInbox(token, collabDir, 'sess-1', { BUS_URGENT_INJECTION_CAP: 3 });
        assert.ok(second.text, 'second call must still have events');
        assert.match(second.text, /msg-3/, 'msg-3 (tail) must re-surface');
        assert.doesNotMatch(second.text, /msg-0/, 'msg-0 was delivered, must not re-appear');
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
        assert.match(result.text, /after-compact/);
        assert.doesNotMatch(result.text, /before-compact/, 'already-delivered events must not re-appear after compact');
      });
    });

    it('tags Discord-sourced events with (Discord) in the formatted output', () => {
      // The inbound poller sets meta.source='discord' on every ingested
      // Discord message. Tagging each event lets the agent tell which
      // inputs originated on Discord and therefore need a Discord reply.
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent(
          'synthetic', 'sess-1', 'user_message', 'ping from a human on Discord',
          { source: 'discord', discord_user_id: 'u1', discord_channel_id: 'b' }
        ));

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.ok(result.text);
        assert.match(result.text, /\(Discord\)/,
          'Discord-sourced events must be tagged so agents know to reply on Discord');
      });
    });

    it('appends a Discord-reply reminder when any event has meta.source="discord"', () => {
      // Without this footer, an agent seeing an urgent Discord message has
      // no in-context cue that plain assistant output will NOT reach the
      // human — the reply path is `wrightward_send_message audience="user"`.
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent(
          'synthetic', 'sess-1', 'user_message', 'help please',
          { source: 'discord' }
        ));

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /wrightward_send_message/,
          'footer must name the MCP tool to use');
        assert.match(result.text, /audience="user"/,
          'footer must name the audience value that routes back to Discord');
      });
    });

    it('omits the Discord footer when no event is Discord-sourced', () => {
      // Pin: the footer must not appear for pure agent-to-agent traffic.
      // Otherwise every heartbeat would nag about Discord even when no
      // Discord message is pending.
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'internal handoff'));

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.ok(result.text);
        assert.doesNotMatch(result.text, /wrightward_send_message/,
          'footer must not appear when no Discord event is pending');
        assert.doesNotMatch(result.text, /\(Discord\)/,
          'non-Discord events must not carry the Discord tag');
      });
    });

    it('appends the Discord footer exactly once even when multiple Discord events arrive', () => {
      // Footer is meant to be a single reminder per injection, not one per
      // event — otherwise a burst of Discord messages would dominate the
      // additionalContext with repeated boilerplate.
      withAgentsLock(collabDir, (token) => {
        for (let i = 0; i < 3; i++) {
          append(token, collabDir, createEvent(
            'synthetic', 'sess-1', 'user_message', 'msg-' + i,
            { source: 'discord' }
          ));
        }

        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        // The per-event reply hint also contains 'wrightward_send_message'.
        // With 3 Discord events + 1 footer, expect exactly 4 matches.
        const matches = result.text.match(/wrightward_send_message/g) || [];
        assert.equal(matches.length, 4,
          'three per-event reply hints + one footer');
        const footerMatches = result.text.match(/Discord messages above/g) || [];
        assert.equal(footerMatches.length, 1,
          'footer must appear exactly once per injection — not once per event');
      });
    });

    it('renders full event id in the line so agents can ack verbatim', () => {
      withAgentsLock(collabDir, (token) => {
        const ev = createEvent('sess-2', 'sess-1', 'handoff', 'run migration tests',
          { task_ref: 'auth refactor' });
        append(token, collabDir, ev);
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, new RegExp('id=' + ev.id.replace(/-/g, '\\-')),
          'full event id must appear in the line');
      });
    });

    it('renders (re: <task_ref>) for handoffs with meta.task_ref', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'do the thing',
          { task_ref: 'auth refactor' }));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /\(re: auth refactor\)/);
      });
    });

    it('handoff line ends with the ack-tool hint', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'handoff', 'do it'));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /→ ack with wrightward_ack/);
      });
    });

    it('file_freed line names the retry hint and the file path', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'file_freed', 'src/auth.ts released',
          { file: 'src/auth.ts' }));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /→ retry your blocked write on src\/auth\.ts/);
      });
    });

    it('Discord user_message line carries the send_message reply hint', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('synthetic', 'sess-1', 'user_message', 'hi',
          { source: 'discord' }));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /→ reply via wrightward_send_message audience="user"/);
      });
    });

    it('agent_message line carries a reply hint addressed by the sender handle', () => {
      withAgentsLock(collabDir, (token) => {
        const from = 'a1b2c3d4-1111-2222-3333-444455556666';
        append(token, collabDir, createEvent(from, 'sess-1', 'agent_message', 'yo'));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        // Hint resolves the sender UUID to its deterministic handle so the
        // reply audience is a human-readable name, not a UUID prefix.
        const expectedHandle = deriveHandle(from);
        assert.ok(result.text.includes(`audience="${expectedHandle}"`),
          'expected handle in hint, got: ' + result.text);
      });
    });

    it('blocker line carries an unblock hint', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'blocker', 'stuck on X'));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /→ another agent is blocked — consider unblocking/);
      });
    });

    it('delivery_failed line points at the bus-status tool', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'delivery_failed', 'dropped'));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /→ see wrightward_bus_status/);
      });
    });

    it('ack line carries no action hint (informational)', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'ack',
          'Ack: accepted — auth refactor', { ack_of: 'x', decision: 'accepted' }));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        assert.match(result.text, /\[ack id=/);
        // No '→' suffix for ack: agent just reads the body.
        const ackLine = result.text.split('\n').find(l => l.includes('[ack id='));
        assert.ok(ackLine, 'ack line should be present');
        assert.doesNotMatch(ackLine, /→/, 'ack line must not carry an action hint');
      });
    });

    it('finding and decision lines carry no action hints (informational)', () => {
      withAgentsLock(collabDir, (token) => {
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'finding', 'bug!'));
        append(token, collabDir, createEvent('sess-2', 'sess-1', 'decision', 'chose X'));
        const result = scanAndFormatInbox(token, collabDir, 'sess-1', {});
        const findingLine = result.text.split('\n').find(l => l.includes('[finding id='));
        const decisionLine = result.text.split('\n').find(l => l.includes('[decision id='));
        assert.ok(findingLine && decisionLine);
        assert.doesNotMatch(findingLine, /→/);
        assert.doesNotMatch(decisionLine, /→/);
      });
    });
  });

  describe('formatEventLine', () => {
    it('includes type, full id, sender handle, body in that order', () => {
      const from = 'fromabcd-1234-5678-90ab-cdef12345678';
      const expectedHandle = deriveHandle(from);
      const ev = { id: 'abcd1234-5678-90ab-cdef-1234567890ab', ts: 1, from,
        to: 'sess-1', type: 'handoff', body: 'B', meta: {}, severity: 'info', expires_at: null };
      const line = formatEventLine(ev);
      assert.equal(line,
        `- [handoff id=abcd1234-5678-90ab-cdef-1234567890ab] from ${expectedHandle}: B → ack with wrightward_ack({id})`);
    });

    it('uses roster handle when provided instead of deriving', () => {
      // Mid-migration safety: when agents.json has a stored handle on the
      // row, formatEventLine prefers it over re-deriving from the UUID.
      const from = 'fromabcd-1234-5678-90ab-cdef12345678';
      const ev = { id: 'x', ts: 1, from, to: 'sess-1', type: 'handoff',
        body: 'B', meta: {}, severity: 'info' };
      const roster = { [from]: { handle: 'bob-42' } };
      assert.match(formatEventLine(ev, roster), /from bob-42/);
    });

    it('omits (re: …) when meta.task_ref is missing', () => {
      const ev = { id: 'x', from: 'fromabcd-1111-2222-3333-444455556666', type: 'handoff', body: 'B', meta: {} };
      assert.doesNotMatch(formatEventLine(ev), /\(re:/);
    });

    it('labels user_message sender as "user", not a hashed handle of SYNTHETIC_SENDER', () => {
      // Discord user messages land on the bus with from=SYNTHETIC_SENDER
      // ('wrightward:runtime'). Running that through handleFor produces a
      // deterministic but fake handle (e.g. 'quinn-3740') that misleads the
      // agent into thinking the human has a handle. The user is not a session.
      const { SYNTHETIC_SENDER } = require('../../lib/bus-schema');
      const ev = {
        id: 'abcd1234-5678-90ab-cdef-1234567890ab',
        ts: 1,
        from: SYNTHETIC_SENDER,
        to: 'sess-1',
        type: 'user_message',
        body: 'hello',
        meta: { source: 'discord' }
      };
      const line = formatEventLine(ev);
      assert.match(line, /from user \(Discord\)/,
        'user_message should be labeled "user", not a synthetic handle: ' + line);
      assert.doesNotMatch(line, /quinn-|from wrightward/,
        'must not leak a derived handle or the synthetic id: ' + line);
    });
  });

  describe('hintForType', () => {
    it('returns an empty string for informational types (ack, finding, decision, note, session_*)', () => {
      for (const type of ['ack', 'finding', 'decision', 'note', 'session_started']) {
        assert.equal(hintForType({ type, meta: {} }), '');
      }
    });
    it('distinguishes Discord user_message from CLI user_message', () => {
      assert.equal(hintForType({ type: 'user_message', meta: {} }), '');
      assert.match(hintForType({ type: 'user_message', meta: { source: 'discord' } }),
        /reply via wrightward_send_message audience="user"/);
    });
    it('omits the file-path for file_freed events missing meta.file', () => {
      assert.equal(hintForType({ type: 'file_freed', meta: {} }), '');
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
