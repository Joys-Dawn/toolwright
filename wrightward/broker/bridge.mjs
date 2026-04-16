// Phase 3 Discord bridge daemon.
//
// Runs as a child of the MCP server. Mirrors bus.jsonl events to Discord
// (forum thread per agent + broadcast channel), and routes @agent- mentions
// from the broadcast channel back into bus.jsonl as user_message events.
//
// REST-only (no gateway) so it can coexist with the stock discord plugin
// on the same bot token. Local bus operation is never blocked by Discord;
// network failures are logged and retried.

import fs from 'fs';
import { createRequire } from 'module';
import { createWatcher } from '../mcp/file-watcher.mjs';
import {
  appendLog,
  recordBridgeFailure,
  recordBridgeSuccess,
  isProcessAlive,
  SELF_RECORDED_FAILURE_EXIT_CODE
} from './lifecycle.mjs';
import { createApi, DiscordApiError } from '../discord/api.js';
import { createThreads } from '../discord/threads.js';
import { formatEvent } from '../discord/formatter.js';
import { createInboundPoller } from './inbound-poll.mjs';

const require = createRequire(import.meta.url);
const { busPath, tailReader, readBookmark, writeBookmark } = require('../lib/bus-log');
const { withAgentsLock, readAgents } = require('../lib/agents');
const { mergePolicy } = require('../lib/mirror-policy');
const { resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { BRIDGE_SESSION_ID } = require('../lib/constants');
const { redactTokens } = require('../lib/discord-sanitize');
const { resolveBotToken } = require('../lib/discord-token');
const busMeta = require('../lib/bus-meta');
const { readContext } = require('../lib/context');

const PARENT_HEARTBEAT_MS = 5000;
// 30s grace period after first event is successfully mirrored before we
// clear the circuit breaker — avoids clearing and immediately re-failing.
const SUCCESS_GRACE_MS = 30_000;

/**
 * Reads fresh events for the bridge's bookmark, with stale-generation rescan.
 * Analogous to lib/bus-delivery.readInboxFresh but WITHOUT the matchesSession
 * filter — the bridge wants to see every event so it can route per policy.
 */
function readBridgeFresh(token, collabDir) {
  const meta = busMeta.readMeta(collabDir);
  const bookmark = readBookmark(collabDir, BRIDGE_SESSION_ID);
  const bookmarkGen = typeof bookmark.generation === 'number' ? bookmark.generation : 0;
  const isStale = bookmarkGen !== meta.generation;
  const fromOffset = isStale ? 0 : (bookmark.lastScannedOffset || 0);

  const lastDeliveredOffset = bookmark.lastDeliveredOffset || 0;
  const needsDedup = isStale || fromOffset <= lastDeliveredOffset;
  const tsFilter = needsDedup ? (bookmark.lastDeliveredTs || 0) : 0;
  const lastDeliveredId = needsDedup ? (bookmark.lastDeliveredId || '') : '';

  const { events: raw, endOffset } = tailReader(token, collabDir, fromOffset);
  const events = tsFilter > 0
    ? raw.filter((e) => e.ts > tsFilter || (e.ts === tsFilter && e.id !== lastDeliveredId))
    : raw;
  return { events, endOffset, bookmark, meta, isStale };
}

/**
 * Seeds the bridge bookmark to the current bus.jsonl file size on first start
 * so we don't mirror the project's historical events. No-op when the bookmark
 * already has state.
 */
function seedBookmarkIfFresh(collabDir) {
  const bm = readBookmark(collabDir, BRIDGE_SESSION_ID);
  if (bm.lastDeliveredOffset || bm.lastScannedOffset) return;
  let size = 0;
  try { size = fs.statSync(busPath(collabDir)).size; } catch (_) { /* no bus yet */ }
  const meta = busMeta.readMeta(collabDir);
  withAgentsLock(collabDir, (token) => {
    writeBookmark(token, collabDir, BRIDGE_SESSION_ID, {
      lastDeliveredOffset: size,
      lastScannedOffset: size,
      lastDeliveredId: '',
      lastDeliveredTs: 0,
      generation: meta.generation || 0
    });
  });
}

/**
 * Dispatches a single event to Discord per mirror policy. Returns true on
 * actionable success (posted/renamed), false when silent/suppressed, throws
 * on API failure.
 */
async function dispatchEvent(event, policy, threads, api, config, collabDir) {
  // Loop-guard: inbound-poll writes events with meta.source='discord'. If we
  // mirrored those back out we'd post Discord-originated messages into
  // Discord threads — noisy and confusing.
  if (event.meta && event.meta.source === 'discord') return false;

  // Roster is read once per dispatch — the sender's handle renders at the
  // TOP of the message (see discord/formatter.js buildContent), and the
  // post_thread branch checks the target is still a live session.
  const roster = readAgents(collabDir);
  const decision = formatEvent(event, policy, roster);

  if (decision.action === 'silent') return false;
  // Defensive: formatter returns `contents: []` for silent/rename_thread, but
  // a mis-wired decision could produce an empty array on a post_* action.
  // Nothing to post means nothing to do.
  if (!decision.contents || decision.contents.length === 0) {
    if (decision.action !== 'rename_thread') return false;
  }

  if (decision.action === 'post_broadcast') {
    // Loop over chunks so a body that exceeds Discord's 2000-byte cap is
    // posted as ordered messages rather than silently truncated. On a
    // mid-sequence failure, earlier chunks stay posted and the outer
    // try/catch in runOutboundTick re-fires the whole event next tick —
    // which duplicates already-posted chunks (accepted v1 tradeoff).
    for (const chunk of decision.contents) {
      await api.postMessage(config.discord.BROADCAST_CHANNEL_ID, chunk);
    }
    return true;
  }

  if (decision.action === 'post_thread') {
    const sessionId = decision.target_session_id;
    if (!sessionId) return false;
    // Drop (don't lazy-create) when the target UUID isn't a live session.
    // This is the fix for the ghost-UUID bug: agents that hallucinated
    // plausible full UUIDs from 8-char hints used to get real Discord
    // threads materialized here. Reconciliation on startup + handle-based
    // addressing at the tool boundary means any target reaching this point
    // with no roster row is either truly gone (race with session_ended) or
    // a hallucinated UUID — either way, silently drop with a log.
    if (!roster[sessionId]) {
      appendLog(collabDir, '[bridge] post_thread dropped: ' + sessionId + ' not in agents.json');
      return false;
    }
    const threadId = threads.getThreadIdFor(sessionId);
    if (!threadId) {
      // Live session, no thread yet. Reconcile should have created it at
      // startup — if we end up here, something raced. Log + drop rather
      // than lazy-create: keeps the bridge's thread inventory predictable.
      appendLog(collabDir, '[bridge] post_thread dropped: ' + sessionId +
        ' has no thread (reconcile may have failed)');
      return false;
    }
    for (const chunk of decision.contents) {
      await api.postMessage(threadId, chunk);
    }
    return true;
  }

  if (decision.action === 'rename_thread') {
    const sessionId = decision.target_session_id;
    if (!sessionId) return false;
    const newTask = (event.meta && event.meta.new_task) || event.body;
    const res = await threads.renameThread(sessionId, newTask);
    return !!res;
  }

  // session_started → ensure thread exists; session_ended → archive
  return false;
}

/**
 * Reads fresh events under lock, releases, dispatches (which may be slow due
 * to network), then reacquires the lock to advance the bookmark.
 *
 * This respects the "never call api.* inside withAgentsLock" rule — Discord
 * REST calls could block for seconds, and other agents must not wait on them.
 */
/**
 * Polls `tick` repeatedly until `deadlineMs` elapses or the `shouldStop`
 * callback returns true. Used during graceful shutdown so events appended
 * by cleanup.js (which races the shutdown path) still get mirrored before
 * we exit — a single drain tick is not enough when the append lands AFTER
 * the tick reads the bus.
 *
 * Each iteration's errors are swallowed (logged via `onError`) so one bad
 * Discord response does not kill the whole drain. The loop ends as soon as
 * now >= deadline.
 *
 * @param {object} opts
 * @param {() => Promise<void>} opts.tick - work to run each iteration
 * @param {number} opts.deadlineMs - absolute ms epoch to stop at
 * @param {number} opts.pollMs - delay between iterations
 * @param {(err: Error) => void} [opts.onError]
 * @param {() => number} [opts.now=Date.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
async function runDrainLoop(opts) {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onError = opts.onError || (() => {});
  while (now() < opts.deadlineMs) {
    try {
      await opts.tick();
    } catch (err) {
      onError(err);
    }
    // Skip the trailing sleep when there isn't room for another full
    // iteration before the deadline — shaves up to pollMs off the shutdown
    // wall time with no loss of event coverage.
    if (opts.deadlineMs - now() <= opts.pollMs) break;
    await sleep(opts.pollMs);
  }
}

async function runOutboundTick(collabDir, policy, api, threads, config) {
  let events, bookmark, meta, isStale, endOffset;
  withAgentsLock(collabDir, (token) => {
    const r = readBridgeFresh(token, collabDir);
    events = r.events;
    bookmark = r.bookmark;
    meta = r.meta;
    isStale = r.isStale;
    endOffset = r.endOffset;
  });
  if (events.length === 0) {
    if (isStale) {
      withAgentsLock(collabDir, (token) => {
        writeBookmark(token, collabDir, BRIDGE_SESSION_ID, {
          lastDeliveredOffset: bookmark.lastDeliveredOffset || 0,
          lastScannedOffset: endOffset,
          lastDeliveredId: bookmark.lastDeliveredId || '',
          lastDeliveredTs: bookmark.lastDeliveredTs || 0,
          generation: meta.generation
        });
      });
    }
    return;
  }

  let lastDelivered = null;
  for (const event of events) {
    try {
      // session_started: ensure thread exists so subsequent handoffs can post
      // into it. Independent of mirror policy (which also posts the event to
      // the broadcast channel per default policy).
      if (event.type === 'session_started' && event.from) {
        if (!threads.getThreadIdFor(event.from)) {
          const ctx = readContext(collabDir, event.from);
          const taskHint = (ctx && ctx.task) || '';
          try {
            await threads.ensureThreadForSession(event.from, taskHint);
          } catch (err) {
            appendLog(collabDir, '[bridge] thread create failed for ' + event.from +
              ': ' + redactTokens(err.message || String(err)));
          }
        }
      }

      const posted = await dispatchEvent(event, policy, threads, api, config, collabDir);
      lastDelivered = event;

      if (event.type === 'session_ended' && event.from) {
        try { await threads.archiveThread(event.from); } catch (err) {
          appendLog(collabDir, '[bridge] archive failed for ' + event.from +
            ': ' + redactTokens(err.message || String(err)));
        }
      }

      // (posted variable intentionally unused here — we advance the bookmark
      //  past every event, not only successful posts. Silent events advance too
      //  so we don't reprocess them.)
      void posted;
    } catch (err) {
      appendLog(collabDir, '[bridge] dispatch error on ' + event.type + ' ' + event.id +
        ': ' + redactTokens(err.message || String(err)));
      // On auth errors, give up immediately — the parent records auth failure.
      if (err instanceof DiscordApiError && (err.status === 401 || err.status === 403)) {
        throw err;
      }
      // For other errors, stop the batch so we retry from this event next tick.
      break;
    }
  }

  if (lastDelivered) {
    withAgentsLock(collabDir, (token) => {
      writeBookmark(token, collabDir, BRIDGE_SESSION_ID, {
        lastDeliveredOffset: lastDelivered._offset,
        lastScannedOffset: endOffset,
        lastDeliveredId: lastDelivered.id,
        lastDeliveredTs: lastDelivered.ts,
        generation: meta.generation
      });
    });
  }
}

async function main() {
  const cwd = process.argv[2] || process.cwd();
  const token = resolveBotToken();
  if (!token) {
    process.stderr.write('[bridge] DISCORD_BOT_TOKEN missing; exiting.\n');
    process.exit(1);
  }

  const resolved = resolveCollabDir(cwd);
  if (!resolved) {
    process.stderr.write('[bridge] no .claude/collab found from ' + cwd + '; exiting.\n');
    process.exit(1);
  }
  const collabDir = resolved.collabDir;
  const config = loadConfig(resolved.root);

  if (!config.discord || !config.discord.ENABLED || !config.BUS_ENABLED) {
    appendLog(collabDir, '[bridge] discord.ENABLED or BUS_ENABLED is false; exiting');
    process.exit(0);
  }
  if (!config.discord.FORUM_CHANNEL_ID || !config.discord.BROADCAST_CHANNEL_ID) {
    appendLog(collabDir, '[bridge] FORUM_CHANNEL_ID or BROADCAST_CHANNEL_ID missing');
    process.exit(1);
  }

  // Arm the success-grace timer only after the first real REST success.
  // Clearing the circuit breaker unconditionally 30s after startup would
  // reset the `consecutive_failures` counter even when the bridge made
  // zero API calls in that window (e.g. empty event bus + dead network).
  // First successful Discord response arms a one-shot 30s timer that then
  // writes recordBridgeSuccess exactly once.
  let successArmed = false;
  function armSuccessTimer() {
    if (successArmed) return;
    successArmed = true;
    setTimeout(() => recordBridgeSuccess(collabDir), SUCCESS_GRACE_MS).unref();
  }

  const api = createApi(token, {
    baseUrl: process.env.DISCORD_API_BASE_URL || undefined,
    userAgent: config.discord.BOT_USER_AGENT || undefined,
    onSuccess: armSuccessTimer
  });
  const threads = createThreads(collabDir, api, config.discord.FORUM_CHANNEL_ID);
  const policy = mergePolicy(config.discord.mirrorPolicy);

  seedBookmarkIfFresh(collabDir);

  // Reconciliation pass: create a thread for every live session in
  // agents.json that doesn't have one. Replaces the lazy-create path that
  // used to live in dispatchEvent (removed to fix the ghost-UUID bug).
  // Runs once at startup; subsequent session_started events are handled
  // inline in the outbound tick. Failures are logged per-session and do
  // not block startup.
  try {
    const result = await threads.reconcileThreads((line) => appendLog(collabDir, line));
    appendLog(collabDir,
      '[bridge] reconcile: created=' + result.created.length +
      ' existing=' + result.existing.length +
      ' failed=' + result.failed.length);
  } catch (err) {
    appendLog(collabDir, '[bridge] reconcile fatal: ' +
      redactTokens(err.message || String(err)));
  }

  const inbound = createInboundPoller(collabDir, api, {
    broadcastChannelId: config.discord.BROADCAST_CHANNEL_ID,
    allowedSenders: config.discord.ALLOWED_SENDERS || [],
    pollIntervalMs: config.discord.POLL_INTERVAL_MS,
    threadsProvider: threads.listActiveThreads,
    logger: (line) => appendLog(collabDir, redactTokens(line))
  });

  // Serialize outbound ticks so we don't invoke two overlapping Discord
  // POSTs for the same backlog. File-watcher bursts get coalesced on the
  // promise queue.
  let queue = Promise.resolve();
  const watcher = createWatcher(busPath(collabDir), () => {
    queue = queue.then(() => runOutboundTick(collabDir, policy, api, threads, config)
      .catch((err) => {
        appendLog(collabDir, '[bridge] tick error: ' + redactTokens(err.message || String(err)));
        if (err instanceof DiscordApiError && err.status === 401) {
          recordBridgeFailure(collabDir, { error: err.message, isAuthFailure: true });
          shutdown(SELF_RECORDED_FAILURE_EXIT_CODE);
        }
      })
    );
  });
  watcher.start();
  inbound.start();

  // Parent watchdog — if the MCP server that spawned us dies (SIGKILL
  // bypasses its handlers), we should exit too. Next MCP server in the
  // same repo will notice the stale lock and take over.
  //
  // NOTE: this timer is NOT unref'd. It's the bridge's liveness anchor —
  // every other timer (inbound poll, file-watcher poll, 30s grace) is
  // unref'd so shutdown() can let the loop drain cleanly. Removing this
  // anchor would let the bridge exit immediately after startup on systems
  // where fs.watch silently fails (e.g. bus.jsonl not yet created).
  const parentPid = process.ppid;
  const parentTimer = setInterval(() => {
    if (!isProcessAlive(parentPid)) {
      appendLog(collabDir, '[bridge] parent pid ' + parentPid + ' dead; exiting');
      shutdown(0);
    }
  }, PARENT_HEARTBEAT_MS);

  // Initial tick to catch anything that arrived between MCP startup and
  // watcher attachment.
  queue = queue.then(() => runOutboundTick(collabDir, policy, api, threads, config)
    .catch((err) => appendLog(collabDir, '[bridge] initial tick: ' +
      redactTokens(err.message || String(err)))));

  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    try { inbound.stop(); } catch (_) {}
    try { clearInterval(parentTimer); } catch (_) {}
    // Drain: cleanup.js appends session_ended to bus.jsonl in parallel with
    // MCP shutdown — the append may land BEFORE, DURING, or AFTER this
    // shutdown starts. The watcher stays live during the drain so real-time
    // appends fire the normal tick path; the drain loop re-reads the bus on
    // a poll interval as a belt-and-braces catch for debounced or missed
    // watcher events. Deadline is held at 2s so the exit is still prompt.
    const DRAIN_MS = 2000;
    const DRAIN_POLL_MS = 250;
    const deadlineMs = Date.now() + DRAIN_MS;
    queue = queue.then(() => runDrainLoop({
      tick: () => runOutboundTick(collabDir, policy, api, threads, config),
      deadlineMs,
      pollMs: DRAIN_POLL_MS,
      onError: (err) => appendLog(collabDir, '[bridge] drain tick: ' +
        redactTokens(err.message || String(err)))
    }));
    Promise.race([
      queue,
      new Promise((r) => setTimeout(r, DRAIN_MS + 500))
    ]).finally(() => {
      try { watcher.close(); } catch (_) {}
      process.exit(code);
    });
  }

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  appendLog(collabDir, '[bridge] started (pid=' + process.pid + ', parent=' + parentPid + ')');
}

// Only run when executed directly, not when imported (so tests can stub).
// Compare via URL to avoid Windows drive-letter casing issues with
// string-equality checks on process.argv[1] and import.meta.url.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const { pathToFileURL } = require('url');
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch (_) { return false; }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write('[bridge] fatal: ' + (err.stack || err.message || err) + '\n');
    process.exit(1);
  });
}

export { main, dispatchEvent, runOutboundTick, runDrainLoop, readBridgeFresh, seedBookmarkIfFresh };
