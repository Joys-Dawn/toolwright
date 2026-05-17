#!/usr/bin/env node
// The single manual seeding entrypoint: seeds short-term memory so the next
// /mindwright:dream has material to consolidate. Always pulls every source —
// CLAUDE.md, README.md, native per-project memory, and transcript history.
//
// Idempotent: markdown/native re-runs skip any source already represented by
// an active short `seed` row; transcript seeding is resumable via offsets.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../lib/paths.js';
import { runSeedLoop } from '../lib/seed-loop.js';
import { collectNativeMemory } from '../lib/native-memory.js';
import { readActiveTicket } from '../lib/daemon-ticket.mjs';
import { DAEMON_TICKET_MAX_AGE_MS } from '../lib/constants.js';
import { depsInstalled } from '../lib/ready.js';
import { maybeAutoInstall, installLogPath } from '../lib/auto-setup.js';

// Shared constant so this script's freshness window and the daemon's cannot
// drift.
export const TICKET_MAX_AGE_MS = DAEMON_TICKET_MAX_AGE_MS;

// Discover the calling Claude session's id from the most-recent ticket file
// (null when run outside Claude → caller uses the synthetic fallback id). No
// claudePid filter — this can be invoked manually outside any hook process
// tree.
export async function findCallingSessionId() {
  try {
    const ticket = await readActiveTicket();
    return ticket ? ticket.session_id : null;
  } catch {
    return null;
  }
}

const FALLBACK_SEED_SESSION_ID = 'seed-from-repo';

// The user-facing "what to do next" line. Pure + exported so the four
// total/dropped/skipped cases are independently unit-testable.
export function describeNextStep({ total, droppedUnderCallingSession, skippedFiles, transcriptRows = 0 }) {
  // Transcript history seeds under each transcript's ORIGINAL session id, so
  // a default session-scoped dream would skip it — when any landed, only
  // scope="all" consolidates everything. Takes precedence over the
  // session-scoped hints below.
  if (transcriptRows > 0) {
    return `Run /mindwright:dream with scope="all" to consolidate everything seeded ` +
      `(repo + native memory + ${transcriptRows} row(s) from your project's transcript history) ` +
      `into long-term facts. scope="all" is required: transcript history seeds under its ` +
      `original session ids, which a default session-scoped dream would skip.`;
  }
  if (total > 0) {
    if (droppedUnderCallingSession) {
      return 'Run /mindwright:dream to consolidate the seeded rows into long-term facts.';
    }
    return `No live Claude session detected; rows landed under "${FALLBACK_SEED_SESSION_ID}". From a Claude session, run /mindwright:dream and tell it to use scope="all" so this batch is included.`;
  }
  if (skippedFiles > 0) {
    // The guard skips a whole file rather than re-chunking edits, so edits
    // made since those rows were first seeded are NOT captured yet — say so
    // explicitly while still pointing at the consolidation step.
    return `${skippedFiles} source file(s) already have un-consolidated short-term seed rows and were skipped; any edits made to them since they were first seeded are NOT captured yet. Run /mindwright:dream to consolidate the existing rows, then re-run /mindwright:seed-from-repo to pick up edited files.`;
  }
  return 'No seed material found.';
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function collectClaudeMdAncestry(root, { includeAncestors = false } = {}) {
  // Default is project-root-only: ancestor walking would pull in
  // ~/.claude/CLAUDE.md (the user's global config — personal preferences,
  // account handles, machine details), which doesn't belong in a single
  // project's DB. Opt in via includeAncestors for monorepo-level CLAUDE.md.
  const found = [];
  let cur = resolve(root);
  while (true) {
    const candidate = join(cur, 'CLAUDE.md');
    const body = readIfExists(candidate);
    if (body) found.push({ path: candidate, body });
    if (!includeAncestors) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

// Stable per-file key for the idempotency guard: markdown emits
// `<path>#section-<N>` (N varies with the byte-budget split) so the key is
// everything before `#section-`; native-memory's `memory:<file>` token is
// itself the key. Matching this short-tier prefix (not the long-term
// provenance, which retainFact rewrites to `drain:<id>`) lets a re-run skip
// a file that is already seeded and not yet drained.
function sourceRefPrefix(sourceRef) {
  const i = sourceRef.indexOf('#section-');
  return i === -1 ? sourceRef : sourceRef.slice(0, i);
}

// Last-resort split for a block that exceeds maxBytes with no heading/blank
// line to split on — without it an oversized section overflows the
// embedder's context window, embedding only its prefix.
//
// Iterates codepoints (Array.from, so an astral-plane char stays one
// element) and accumulates by UTF-8 byte length. A naive slice would budget
// by UTF-16 code units (a CJK char is 1 unit but 3 UTF-8 bytes) and could
// split a surrogate pair into lone surrogates the embedder maps to U+FFFD.
function hardSplitBlock(blk, maxBytes) {
  const out = [];
  const codepoints = Array.from(blk);
  let buf = '';
  let bufBytes = 0;
  for (const cp of codepoints) {
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    // A single codepoint over budget can't be split — emit it alone so the
    // loop makes forward progress and no content is dropped.
    if (cpBytes > maxBytes) {
      if (buf.length) { out.push(buf); buf = ''; bufBytes = 0; }
      out.push(cp);
      continue;
    }
    if (bufBytes + cpBytes > maxBytes) {
      out.push(buf);
      buf = cp;
      bufBytes = cpBytes;
    } else {
      buf += cp;
      bufBytes += cpBytes;
    }
  }
  if (buf.length) out.push(buf);
  return out;
}

export function splitMarkdownSections(body, maxBytes = 4000) {
  // Split on top-level headings. If a section is too large, chunk it on blank lines.
  const sections = [];
  const parts = body.split(/(?=^#\s)/m);
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
      sections.push(trimmed);
      continue;
    }
    // Long section — split on blank lines, accumulate up to maxBytes.
    // Pre-expand individually-oversized blocks via hardSplitBlock so the
    // accumulator never holds an already-over-budget chunk (e.g. a section
    // that is one giant blank-line-free code block).
    const rawBlocks = trimmed.split(/\n\s*\n/);
    const blocks = [];
    for (const b of rawBlocks) {
      if (Buffer.byteLength(b, 'utf8') > maxBytes) {
        for (const sub of hardSplitBlock(b, maxBytes)) blocks.push(sub);
      } else {
        blocks.push(b);
      }
    }
    let buf = '';
    for (const blk of blocks) {
      const sepBytes = buf ? 2 : 0;
      if (Buffer.byteLength(buf, 'utf8') + sepBytes + Buffer.byteLength(blk, 'utf8') > maxBytes && buf) {
        sections.push(buf);
        buf = blk;
      } else {
        buf = buf ? `${buf}\n\n${blk}` : blk;
      }
    }
    if (buf) sections.push(buf);
  }
  return sections;
}

async function main() {
  // Dependency gate: check before importing openStore() (the only native-dep
  // import) so a deps-less copy returns a structured "not ready" result
  // instead of crashing at ESM load.
  if (!depsInstalled()) {
    maybeAutoInstall();
    const msg = `mindwright native dependencies not installed yet — a one-time background install was triggered (log: ${installLogPath()}). Re-run /mindwright:seed-from-repo once it completes.`;
    process.stderr.write(msg + '\n');
    process.stdout.write(
      JSON.stringify({ ok: false, error: 'deps_not_installed', short_rows_inserted: 0, detail: msg }) + '\n',
    );
    return;
  }
  const { openStore } = await import('../lib/store.js');
  const root = projectRoot();
  const includeAncestors = process.argv.slice(2).includes('--include-ancestors');
  const callingSessionId = await findCallingSessionId();
  const sessionId = callingSessionId || FALLBACK_SEED_SESSION_ID;
  const store = openStore();
  let total = 0;
  let claudeMdCount = 0;
  let nativeMemoryFiles = 0;
  let skippedFiles = 0;
  let transcriptSummary = { transcriptsSeeded: 0, rowsInserted: 0, skipped: 0 };
  let transcriptError = null;
  try {
    // Collect everything first (file reads) so the SQLite transaction only
    // holds for the inserts.
    const claudeMds = collectClaudeMdAncestry(root, { includeAncestors });
    claudeMdCount = claudeMds.length;
    const readme = readIfExists(join(root, 'README.md'));
    // Native per-project memory is always included (not a fallback);
    // collectNativeMemory() returns [] when the project has no such tree.
    const nativeMemory = collectNativeMemory();
    nativeMemoryFiles = nativeMemory.length;

    // Idempotency guard: skip a source file wholesale if ANY active short
    // `seed` row exists under its source_ref prefix. Accept staleness rather
    // than diffing content every run — the next dream refreshes long-term
    // anyway. Short-tier only: retainFact rewrites long-term source_ref to
    // `drain:<id>`, erasing the origin path.
    const seededPrefixes = new Set(
      store.db
        .prepare(
          `SELECT DISTINCT source_ref FROM entries
             WHERE tier='short' AND kind='seed' AND active=1
               AND source_ref IS NOT NULL`,
        )
        .all()
        .map((r) => sourceRefPrefix(r.source_ref)),
    );

    const markdownSources = [
      ...claudeMds,
      ...(readme ? [{ path: join(root, 'README.md'), body: readme }] : []),
    ];

    // Single transaction across all inserts: WAL mode pays one fsync per
    // implicit-txn insert, so wrapping collapses 30-100 fsyncs to one.
    const seedTxn = store.db.transaction(() => {
      for (const { path, body } of markdownSources) {
        if (seededPrefixes.has(path)) { skippedFiles++; continue; }
        const sections = splitMarkdownSections(body);
        for (let i = 0; i < sections.length; i++) {
          store.insertEntry({
            tier: 'short',
            kind: 'seed',
            content: sections[i],
            sourceRef: `${path}#section-${i + 1}`,
            sessionId,
          });
          total++;
        }
      }

      // Native-memory rows carry an event_ts (frontmatter date or file
      // mtime) the recency invariant ranks on; CLAUDE.md/README sections
      // stay NULL event_ts.
      for (const { content, eventTs, sourceRef } of nativeMemory) {
        if (seededPrefixes.has(sourceRefPrefix(sourceRef))) {
          skippedFiles++;
          continue;
        }
        store.insertEntry({
          tier: 'short',
          kind: 'seed',
          content,
          sourceRef,
          sessionId,
          eventTs,
        });
        total++;
      }
    });
    seedTxn();

    // Transcript history — always, not optional. The resumable loop skips
    // any session that already has an offsets row (never double-ingested).
    // No `consolidate` injected: a manual skill only ingests, so it does not
    // spawn a surprise background consolidator. Best-effort: a
    // transcript-side failure must not lose the just-committed rows or crash.
    try {
      transcriptSummary = await runSeedLoop({ store });
    } catch (e) {
      transcriptError = (e && e.message) ? e.message : String(e);
      process.stderr.write(`mindwright seed-from-repo — transcript seeding failed (markdown/native rows kept): ${transcriptError}\n`);
    }
  } finally {
    store.close();
  }

  const readmePresent = existsSync(join(root, 'README.md'));
  // Seeded under the calling session ⇒ default scope=session dream drains
  // them; otherwise the user needs scope=all for the fallback session id.
  const droppedUnderCallingSession = !!callingSessionId;
  const transcriptRows = transcriptSummary.rowsInserted || 0;
  const nextStep = describeNextStep({
    total, droppedUnderCallingSession, skippedFiles, transcriptRows,
  });

  const result = {
    ok: true,
    short_rows_inserted: total,
    claude_md_files: claudeMdCount,
    claude_md_mode: includeAncestors ? 'ancestors' : 'project-root',
    readme_present: readmePresent,
    native_memory_files: nativeMemoryFiles,
    skipped_already_seeded: skippedFiles,
    transcripts_seeded: transcriptSummary.transcriptsSeeded || 0,
    transcript_rows_inserted: transcriptRows,
    transcripts_skipped: transcriptSummary.skipped || 0,
    transcript_error: transcriptError,
    session_id: sessionId,
    next_step: nextStep,
  };
  const modeNote = includeAncestors
    ? ' (CLAUDE.md walk includes parent dirs — global ~/.claude/CLAUDE.md may be ingested)'
    : ' (CLAUDE.md scope: project root only — pass --include-ancestors to walk parent dirs)';
  process.stderr.write(
    `mindwright seed-from-repo — inserted ${total} repo/native row(s) under session "${sessionId}" ` +
    `+ ${transcriptRows} transcript row(s) from ${result.transcripts_seeded} transcript(s)${modeNote}.\n`,
  );
  if (total > 0 || transcriptRows > 0) process.stderr.write(`Next: ${nextStep}\n`);
  process.stdout.write(JSON.stringify(result) + '\n');
}

// Only invoke main() when executed directly (CLI), not when a test imports
// the helpers.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`mindwright seed-from-repo crashed: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}
