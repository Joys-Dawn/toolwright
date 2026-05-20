#!/usr/bin/env node
// SessionStart hook: init transcript offset, run a bounded deferred-embed
// sweep, write the session ticket, inject a short status line. On any error
// it exits without injecting context — a failure here must not block the
// session.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { embedderCached } from '../lib/paths.js';
import { pluralize } from '../lib/grammar.js';
import { writeTicket } from '../lib/daemon-ticket.mjs';
import { logHookError } from '../lib/hook-log.js';
import { getRolePromptsFor } from '../lib/role-prompts.js';
import { writeSidecar } from '../lib/role-sidecar.js';
import { initOffsetIfUnknown } from '../lib/offset-init.js';
import { connectPipe } from '../lib/pipe-client.js';
import { sweepOnce } from '../lib/sweeper.js';
import { promoteAndMaybeSpawn } from '../lib/promote-pending.js';
import { SELF_RECALL_RULE, ORPHAN_FLUSH_THRESHOLD_MS } from '../lib/constants.js';

export async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stdout.write('{}\n');
    return;
  }
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;

  let store;
  let initOffsetMessage = '';
  let longCount = 0;
  let assignedRoles = [];
  try {
    store = openStore();
  } catch (e) {
    logHookError('session-start', 'store open failed', e);
    process.stdout.write('{}\n');
    return;
  }

  try {
    if (sessionId) {
      try {
        // Shared with the first transcript flush so the EOF decision is made
        // exactly once even when this hook was dormant on a deps-less first
        // run. Idempotent via the hasOffsetRow latch.
        const r = await initOffsetIfUnknown({ store, sessionId, transcriptPath });
        if (r.message) initOffsetMessage = r.message;

        // SessionStart-ONLY opt-in re-ingest of an already-tracked session:
        // safe here because SessionStart fires once per session, but unsafe
        // in the shared helper (per-flush, resetting offset to 0 every flush
        // would be an unbounded re-ingest loop). `existing > 0` distinguishes
        // a tracked session from a fresh-opt-in value-0 latch row.
        if (
          !r.initialized &&
          transcriptPath &&
          process.env.MINDWRIGHT_SEED_TRANSCRIPT === '1' &&
          existsSync(transcriptPath) &&
          store.hasOffsetRow(sessionId)
        ) {
          const size = statSync(transcriptPath).size;
          const existing = store.getOffset(sessionId);
          if (size > 0 && existing > 0) {
            store.setOffset(sessionId, 0);
            initOffsetMessage =
              `MINDWRIGHT_SEED_TRANSCRIPT=1 — re-ingesting prior transcript from byte 0 (was ${existing}). ` +
              `This may duplicate already-chunked turns; /mindwright:dream's supersede check deduplicates them.`;
          }
        }
      } catch (e) {
        logHookError('session-start', 'offset init failed', e);
      }
      longCount = store.countByTier().long || 0;

      // Clear per-session dedup + last-query-embedding state so a fresh
      // boot starts cold.
      try { assignedRoles = store.getRoles(sessionId); } catch { assignedRoles = []; }
      try { store.clearInjectedFactIds(sessionId); } catch { /* best-effort */ }
      try { store.clearLastQueryEmb(sessionId); } catch { /* best-effort */ }
      try { store.clearDaemonDownWarned(sessionId); } catch { /* best-effort */ }
      // Sidecar baseline for PostToolUse-on-inbox to diff against.
      try { writeSidecar(sessionId, assignedRoles); } catch (e) {
        logHookError('session-start', 'sidecar write failed', e);
      }

      // Deferred-embed sweep. Rows written with embedding=NULL while the
      // machine model daemon was down get back-filled here, best-effort and
      // bounded to one batch. Only engages the daemon when there is an actual
      // backlog (common path is one cheap count). Probe first so a transient
      // daemon-down skips the sweep cleanly instead of bumping embed_failures
      // on healthy rows.
      try {
        if (embedderCached() && store.countPendingEmbeds() > 0) {
          const pipe = connectPipe(sessionId);
          const probe = await pipe.embed(['mindwright sweep probe']);
          if (Array.isArray(probe) && probe[0] instanceof Float32Array) {
            await sweepOnce(store, async (texts) => {
              const v = await pipe.embed(texts);
              if (!Array.isArray(v)) throw new Error('model daemon unavailable mid-sweep');
              return v;
            });
          }
        }
      } catch (e) {
        logHookError('session-start', 'deferred-embed sweep failed', e);
      }

      // Orphan-pending sweep. Pending rows whose owning session went quiet
      // longer than ORPHAN_FLUSH_THRESHOLD_MS are almost certainly stuck —
      // the originating session crashed, was killed, or otherwise never
      // fired its PreCompact/SessionEnd. Promote them (move pending →
      // real short-term) on the dead session's behalf so the content joins
      // long-term memory normally. Excludes our own session_id so a live
      // /resume from lunch doesn't have its pending bucket prematurely
      // promoted.
      try {
        // Pin `now` so the orphan SELECT cutoff and the per-orphan UPDATE
        // cutoff are IDENTICAL. Without this, an "orphan" session that
        // resurrects via /resume between the SELECT and the UPDATE could
        // have just-written FRESH pending rows promoted out from under it,
        // reintroducing the self-echo class the staging design eliminates.
        const sweepNow = Date.now();
        const sweepCutoff = new Date(sweepNow - ORPHAN_FLUSH_THRESHOLD_MS).toISOString();
        const orphans = store.orphanPendingSessions({
          now: sweepNow,
          thresholdMs: ORPHAN_FLUSH_THRESHOLD_MS,
          currentSessionId: sessionId,
        });
        for (const o of orphans) {
          promoteAndMaybeSpawn({
            store,
            ownerSessionId: o.session_id,
            callerSessionId: sessionId,
            tag: 'session-start orphan-sweep',
            // Promote only rows that were ALREADY older than the cutoff at
            // SELECT time. Any pending row the resurrected owner writes
            // after SELECT stays pending until that owner's own flush.
            maxCreatedAt: sweepCutoff,
          });
          // An orphan session by definition won't run its own SessionEnd to
          // clear the tool_map; do it here so its persisted buffer doesn't
          // linger in meta indefinitely. clearToolMap is a no-op when the
          // row doesn't exist.
          try {
            store.clearToolMap(o.session_id);
          } catch (e) {
            logHookError('session-start', 'orphan clearToolMap failed', e);
          }
        }
      } catch (e) {
        logHookError('session-start', 'orphan-pending sweep failed', e);
      }
    }
  } catch (e) {
    logHookError('session-start', 'db work failed', e);
  } finally {
    store.close();
  }

  // Ticket write (best-effort; failure must not block startup).
  if (sessionId) {
    try {
      await writeTicket({ sessionId });
    } catch (e) {
      logHookError('session-start', 'ticket write failed', e);
    }
  }

  // The self-recall rule is gated below on (embedderCached && longCount > 0)
  // — emitting it before there's anything to recall just teaches the agent
  // to call a tool that errors with SETUP_HINT or returns [].
  const lines = [];
  // Time grounding. Agents otherwise reason about time from a stale training
  // cutoff; an ISO timestamp anchors "when did X happen" against the same
  // clock retrieved memories carry (lib/recall-format.js `ts=` token).
  lines.push(`Current time: ${new Date().toISOString()}`);
  if (longCount > 0) {
    lines.push(`mindwright bound; ${pluralize(longCount, 'long-term fact')} available.`);
  }
  // Setup hint. embedderCached() is the cheapest existsSync that distinguishes
  // "setup ran" from "setup never ran."
  if (!embedderCached()) {
    lines.push(
      'mindwright models not cached yet — run `/mindwright:setup` to enable recall (one-time ~5 GB download).'
    );
  }
  if (initOffsetMessage) lines.push(initOffsetMessage);

  // Role prompts come first so the agent reads "you are an X" before the
  // self-recall rule that depends on that identity.
  const rolePrompts = getRolePromptsFor(assignedRoles);
  if (rolePrompts) lines.push(rolePrompts);
  if (embedderCached() && longCount > 0) {
    lines.push(SELF_RECALL_RULE);
  }

  if (lines.length === 0) {
    process.stdout.write('{}\n');
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        // Join with blank lines so multi-line fragments render as distinct
        // paragraphs in the agent's context.
        additionalContext: lines.join('\n\n'),
      },
    }) + '\n'
  );
}
