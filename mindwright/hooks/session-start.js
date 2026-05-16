#!/usr/bin/env node
// SessionStart hook. Three jobs:
//   1) Write a ticket file binding this Claude CLI process to its mindwright
//      session so the in-process MCP daemon can find its session id.
//   2) Initialize the per-session transcript offset. For an unknown session
//      (no offset row yet) we default to current EOF so we don't retroactively
//      ingest pre-mindwright history. BUT — if the transcript already
//      contains substantial content, that probably means mindwright is
//      meeting a `claude --resume`d session for the first time; we warn the
//      user explicitly so they know prior content was skipped. Users who
//      want the historical content ingested can set
//      `MINDWRIGHT_SEED_TRANSCRIPT=1` before launching; we'll leave the
//      offset at 0 and let the first PreToolUse pass chunk from the top.
//   3) Emit a short status line via `additionalContext` so the agent sees
//      whether mindwright is warm or degraded.
//
// On any error this hook exits without injecting context. Mindwright is opt-in
// memory; a failure here must not block the session.

import { readFileSync, statSync, existsSync, createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.js';
import { pipePath, embedderCached } from '../lib/paths.js';
import { pluralize } from '../lib/grammar.js';
import { writeTicket } from '../mcp/daemon-ticket.mjs';
import { logHookError } from '../lib/hook-log.js';
import { getRolePromptsFor } from '../lib/role-prompts.js';
import { writeSidecar } from '../lib/role-sidecar.js';
import { maybeAutoSeed } from '../lib/seed-trigger.js';
import { SELF_RECALL_RULE } from '../lib/constants.js';

// Any prior transcript longer than this triggers the "first time meeting a
// resumed session" warning. A handful of empty turns produces less than this;
// anything past it is meaningful prior conversation.
const RESUMED_SESSION_WARN_BYTES = 4096;

// Count newline-delimited records in a JSONL transcript. Streams the file
// so we don't allocate a multi-MB buffer for what is conceptually a single
// integer — this helper only fires when size > RESUMED_SESSION_WARN_BYTES,
// so the transcripts it sees are always at least 4 KB and frequently much
// larger. Best-effort: any read failure resolves to null and the warning
// falls back to bytes only.
export function countTranscriptRecords(transcriptPath) {
  return new Promise((resolve) => {
    let n = 0;
    let settled = false;
    const stream = createReadStream(transcriptPath);
    stream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) n++;
      }
    });
    stream.on('end', () => {
      if (!settled) { settled = true; resolve(n); }
    });
    stream.on('error', () => {
      if (!settled) { settled = true; resolve(null); }
    });
  });
}

async function main() {
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
      const existing = store.getOffset(sessionId);
      if (transcriptPath && existsSync(transcriptPath)) {
        try {
          const size = statSync(transcriptPath).size;
          const optIn = process.env.MINDWRIGHT_SEED_TRANSCRIPT === '1';
          if (optIn && size > 0) {
            // Honor MINDWRIGHT_SEED_TRANSCRIPT regardless of whether
            // mindwright has tracked this session before. Silently ignoring
            // an explicit opt-in on already-tracked sessions used to leave
            // users restarting Claude over and over wondering why their
            // historical content never landed. Two branches:
            //   - Fresh session (offset=0): just set the seed message and
            //     leave offset at 0; the next PreToolUse pass chunks the
            //     whole file from the top.
            //   - Tracked session (offset>0): reset offset to 0 to re-ingest
            //     prior content. Warn about likely duplicates — the next
            //     /mindwright:dream's supersede-candidate detection
            //     deduplicates semantically.
            if (existing > 0) {
              store.setOffset(sessionId, 0);
              initOffsetMessage =
                `MINDWRIGHT_SEED_TRANSCRIPT=1 — re-ingesting prior transcript from byte 0 (was ${existing}). ` +
                `This may duplicate already-chunked turns; /mindwright:dream's supersede check deduplicates them.`;
            } else {
              initOffsetMessage =
                `MINDWRIGHT_SEED_TRANSCRIPT=1 — ingesting prior transcript (${size} bytes) on next tool call`;
            }
          } else if (existing === 0) {
            store.setOffset(sessionId, size);
            if (size > RESUMED_SESSION_WARN_BYTES) {
              // Resumed session that mindwright is meeting for the first
              // time. Be explicit so the user knows their pre-existing
              // history was deliberately skipped and how to ingest it.
              // Record count gives the user a much better intuition than
              // a raw byte count for "how much conversation am I about to
              // miss / ingest?" — JSONL has one record per line.
              const recordCount = await countTranscriptRecords(transcriptPath);
              const sizeDesc = recordCount == null
                ? `${size} bytes`
                : `${size} bytes / ~${recordCount} records`;
              initOffsetMessage =
                `note: this transcript already contains ${sizeDesc} from before mindwright was tracking it. ` +
                `Set MINDWRIGHT_SEED_TRANSCRIPT=1 and restart this session to ingest the prior content; ` +
                `otherwise only new turns from here on are chunked into short-term.`;
            }
            // No message for the silent fresh-session case — initializing the
            // offset to EOF is internal bookkeeping with no value to Claude or
            // the user. Stays out of additionalContext so context budget
            // isn't burned on debug info.
          }
        } catch {
          // best-effort; offset stays whatever it was if stat fails
        }
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

// Only run main() when this file is invoked directly by Claude Code (as a
// hook script), not when imported for unit testing — the import path
// would otherwise trigger a stdin read that blocks the test runner.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    logHookError('session-start', 'crashed', err);
    process.stdout.write('{}\n');
  });
}
