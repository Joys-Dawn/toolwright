#!/usr/bin/env node
// SessionStart hook. Three jobs:
//   1) Write a ticket file binding this Claude CLI process to its mindwright
//      session so the in-process MCP daemon can find its session id.
//   2) Initialize the per-session transcript offset via the shared,
//      trigger-agnostic lib/offset-init.js#initOffsetIfUnknown. For an unknown
//      session it defaults to current EOF so we don't retroactively ingest
//      pre-mindwright history (unless MINDWRIGHT_SEED_TRANSCRIPT=1), and warns
//      when meeting a `claude --resume`d session for the first time. The same
//      helper backstops the first transcript flush, so the decision is made
//      exactly once regardless of which entrypoint first sees the session
//      (behavior-1) — critical because this hook is dormant on a deps-less
//      first run and would otherwise never make the decision at all. An
//      explicit MINDWRIGHT_SEED_TRANSCRIPT=1 on an ALREADY-tracked session
//      (behavior-8) is handled here only — never in the shared helper, since
//      it is unsafe to share with the per-flush backstop (see the inline
//      note); SessionStart runs once per session, so the reset is safe here.
//   3) Emit a short status line via `additionalContext` so the agent sees
//      whether mindwright is warm or degraded.
//
// On any error this hook exits without injecting context. Mindwright is opt-in
// memory; a failure here must not block the session.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { openStore } from '../lib/store.js';
import { pipePath, embedderCached } from '../lib/paths.js';
import { pluralize } from '../lib/grammar.js';
import { writeTicket } from '../mcp/daemon-ticket.mjs';
import { logHookError } from '../lib/hook-log.js';
import { getRolePromptsFor } from '../lib/role-prompts.js';
import { writeSidecar } from '../lib/role-sidecar.js';
import { maybeAutoSeed } from '../lib/seed-trigger.js';
import { initOffsetIfUnknown } from '../lib/offset-init.js';
import { SELF_RECALL_RULE } from '../lib/constants.js';

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
        // Trigger-agnostic offset init (behavior-1). The decision + the
        // resumed-session warning now live in lib/offset-init.js so the
        // first transcript flush can run the SAME logic when this hook was
        // dormant on a deps-less first run. Idempotent via the hasOffsetRow
        // existence latch: an immediate no-op on an already-tracked session,
        // so SessionStart (eager) and the flush backstop never disagree or
        // double-warn. Never throws by contract; the guard is belt-and-
        // suspenders so a bookkeeping failure can't block the session.
        const r = await initOffsetIfUnknown({ store, sessionId, transcriptPath });
        if (r.message) initOffsetMessage = r.message;

        // SessionStart-ONLY: opt-in re-ingest of an ALREADY-tracked session
        // (behavior-8). initOffsetIfUnknown above is gated on !hasOffsetRow —
        // it MUST be, because it also backstops the per-flush transcript path,
        // where resetting a tracked session's offset to 0 on every flush would
        // be an unbounded re-ingest/duplicate loop. But an explicit
        // MINDWRIGHT_SEED_TRANSCRIPT=1 on a session mindwright already tracked
        // is a deliberate user request to re-seed the older content, and it is
        // safe HERE precisely because SessionStart fires exactly once per
        // session. So this branch lives in this once-per-session entrypoint
        // only, never in the shared helper. (Preserves the original
        // session-start opt-in-on-tracked behavior; the Cluster-A plan
        // requires "SessionStart behavior preserved". `existing > 0`
        // distinguishes a genuinely-tracked session from a fresh-opt-in
        // value-0 latch row, exactly as the original code did.)
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

      // Read assigned roles for context injection. Clear per-session
      // dedup + last-query-embedding state so a fresh boot starts cold.
      try { assignedRoles = store.getRoles(sessionId); } catch { assignedRoles = []; }
      try { store.clearInjectedFactIds(sessionId); } catch { /* best-effort */ }
      try { store.clearLastQueryEmb(sessionId); } catch { /* best-effort */ }
      try { store.clearDaemonDownWarned(sessionId); } catch { /* best-effort */ }
      // Persist the role sidecar so PostToolUse-on-inbox has a baseline
      // to diff against. Best-effort — sidecar absence is recoverable on
      // first diff (treats current roles as additions and re-injects).
      try { writeSidecar(sessionId, assignedRoles); } catch (e) {
        logHookError('session-start', 'sidecar write failed', e);
      }

      // Transcript-bootstrap auto-trigger. SessionStart is the ONLY point
      // genuine install-time emptiness is observable: it runs before the
      // turn's first flush (UserPromptSubmit / PreToolUse / Stop all flush
      // transcript chunks into short-term, so by the first Stop the
      // empty-memory precondition can never hold — behavior-1). The offset
      // write above already marked THIS session live, so the loop seeds only
      // the genuinely pre-install transcripts, never the current one.
      // Fire-and-forget + self-guarded; never blocks or fails session start.
      maybeAutoSeed(store, sessionId);
    }
  } catch (e) {
    logHookError('session-start', 'db work failed', e);
  } finally {
    store.close();
  }

  // Ticket write (best-effort; failure does NOT block startup).
  if (sessionId) {
    try {
      await writeTicket({ sessionId, pipePath: pipePath(sessionId) });
    } catch (e) {
      logHookError('session-start', 'ticket write failed', e);
    }
  }

  // Emit additionalContext on every boot. Role fragments + status hints
  // (resumed-session, long-term count, setup hint) always emit when relevant.
  // The self-recall rule is gated below on (embedderCached && longCount > 0)
  // — emitting it before there's anything to recall just teaches the agent
  // to call a tool that errors with SETUP_HINT or returns [].
  const lines = [];
  // Always-on time grounding. Agents otherwise reason about time from a
  // stale training cutoff or whatever date string lingers in their context;
  // an ISO timestamp at the top of every boot anchors all subsequent
  // reasoning about "when did X happen" against the same clock retrieved
  // memories carry (see lib/recall-format.js `ts=` token).
  lines.push(`Current time: ${new Date().toISOString()}`);
  if (longCount > 0) {
    lines.push(`mindwright bound; ${pluralize(longCount, 'long-term fact')} available.`);
  }
  // Setup hint. embedderCached() is the cheapest existsSync that distinguishes
  // "setup ran" from "setup never ran." Single source of truth — same helper
  // also gates MCP handlers and feeds mindwright_status / scripts/status.js.
  if (!embedderCached()) {
    lines.push(
      'mindwright models not cached yet — run `/mindwright:setup` to enable recall (one-time ~5 GB download).'
    );
  }
  if (initOffsetMessage) lines.push(initOffsetMessage);

  // Role prompts come first so the agent reads "you are an X" before the
  // self-recall rule that depends on that identity. Unknown roles silently
  // skip — they still scope retrieval but inject no fragment.
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
        // Role prompts + self-recall rule are multi-line; join with
        // newlines so they render as distinct paragraphs in the agent's
        // context. Older single-line status messages stay on one line each.
        additionalContext: lines.join('\n\n'),
      },
    }) + '\n'
  );
}
