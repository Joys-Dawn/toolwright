/**
 * Channel doorbell — Phase 2 wake-up path.
 *
 * `ring(server, collabDir, sessionId)` reads the inbox under lock (read-only,
 * no bookmark advance) and, if any urgent events are pending, emits exactly
 * one `notifications/claude/channel` summary frame to wake the idle session.
 *
 * The doorbell writes no state. Path 1 (hooks) remains the sole owner of the
 * bookmark and the sole deliverer of event content. Path 2's notification is
 * a best-effort wake-up signal — if the notification silently drops (known
 * Claude Code stdio channel bugs), Path 1 still delivers on the user's next
 * interaction. This design absorbs notification failure gracefully.
 *
 * Load-bearing invariant: this module must NEVER call advanceBookmark or
 * otherwise write to `.claude/collab/bus-delivered/<sessionId>.json`. The
 * `channel-doorbell.test.mjs` suite pins this with a "bookmark bytes
 * unchanged after ring()" assertion.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { withAgentsLock } = require('../lib/agents');
const { readInboxFresh } = require('../lib/bus-delivery');

function buildSummary(pendingCount) {
  if (pendingCount === 1) {
    return 'You have 1 new wrightward bus event. Your next tool call (or /wrightward:inbox) will surface it.';
  }
  return `You have ${pendingCount} new wrightward bus events. Your next tool call (or /wrightward:inbox) will surface them.`;
}

export async function ring(server, collabDir, sessionId) {
  if (!sessionId) return { pinged: false, reason: 'unbound' };

  let pendingCount = 0;
  try {
    withAgentsLock(collabDir, (token) => {
      const { events } = readInboxFresh(token, collabDir, sessionId);
      pendingCount = events.length;
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write('[wrightward-mcp] doorbell read failed: ' + msg + '\n');
    return { pinged: false, reason: 'read-error', error: msg };
  }

  if (pendingCount === 0) return { pinged: false, reason: 'empty' };

  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: buildSummary(pendingCount),
        meta: {
          source: 'wrightward-bus',
          pending_count: String(pendingCount)
        }
      }
    });
    return { pinged: true, pendingCount };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write('[wrightward-mcp] doorbell ring failed: ' + msg + '\n');
    return { pinged: false, reason: 'notification-error', error: msg };
  }
}

export { buildSummary };
