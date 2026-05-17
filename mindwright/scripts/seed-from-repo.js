#!/usr/bin/env node
// Seed short-term memory from repo-local signals so the next /mindwright:dream
// has material to consolidate from when memory is empty. Pulls from:
//   - CLAUDE.md (project root only; --include-ancestors also walks parent dirs)
//   - README.md (root)
//   - Claude Code's native per-project memory (~/.claude/projects/<cwd>/memory)
//
// Each item lands as a `short` tier row with kind="seed". The consolidator
// treats them like any other short-term content during dream. Idempotent:
// re-running skips any source file already represented by an active short
// `seed` row (matched on the source_ref file-path prefix) so repeated
// invocations don't pile duplicates.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../lib/paths.js';
import { collectNativeMemory } from '../lib/native-memory.js';
import { readActiveTicket } from '../mcp/daemon-ticket.mjs';
import { DAEMON_TICKET_MAX_AGE_MS } from '../lib/constants.js';
import { depsInstalled } from '../lib/ready.js';
import { maybeAutoInstall, installLogPath } from '../lib/auto-setup.js';

// Re-exported so callers (and tests) reference a single source-of-truth
// constant. The actual value lives in lib/constants.js#DAEMON_TICKET_MAX_AGE_MS;
// drift between this script's freshness window and the daemon's would
// silently change behavior, so the constant is shared.
export const TICKET_MAX_AGE_MS = DAEMON_TICKET_MAX_AGE_MS;

// Find the calling Claude session's id from the most-recent ticket file
// written by `hooks/session-start.js`. When the script is run inside a
// live Claude session, returns that session's id — seeded rows then land
// under the calling session and default `/mindwright:dream` scope picks
// them up. When run outside Claude (no fresh ticket), returns null so
// the caller falls back to the synthetic id.
//
// Delegates to the canonical ticket reader so freshness/parse rules don't
// drift between this script and the MCP daemon. We do NOT filter by
// claudePid here — seed-from-repo can be invoked manually outside the
// SessionStart-rooted process tree (e.g., from `/mindwright:seed-from-repo`
// where the script's parent isn't the Claude CLI).
export async function findCallingSessionId() {
  try {
    const ticket = await readActiveTicket();
    return ticket ? ticket.session_id : null;
  } catch {
    return null;
  }
}

const FALLBACK_SEED_SESSION_ID = 'seed-from-repo';

// The user-facing "what to do next" line. Pure + exported so the messaging
// contract (the four total/dropped/skipped cases) is independently
// unit-testable instead of buried in a 3-level nested ternary with an
// interleaved comment (best-practices-4). Guard-style: one return per case.
export function describeNextStep({ total, droppedUnderCallingSession, skippedFiles }) {
  if (total > 0) {
    if (droppedUnderCallingSession) {
      return 'Run /mindwright:dream to consolidate the seeded rows into long-term facts.';
    }
    return `No live Claude session detected; rows landed under "${FALLBACK_SEED_SESSION_ID}". From a Claude session, run /mindwright:dream and tell it to use scope="all" so this batch is included.`;
  }
  if (skippedFiles > 0) {
    // Nothing NEW inserted because every source already has an un-drained
    // short seed row. By design the guard skips a whole file rather than
    // re-chunking edits (seed-from-repo/SKILL.md), so any edits made since
    // those rows were first seeded are NOT captured yet. Say that
    // explicitly — "All seed sources are already present" masked silent
    // non-capture of edits a user just made and re-ran to capture — while
    // still pointing at the actionable consolidation step.
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
  // Collect CLAUDE.md at `root`. With includeAncestors=true, also walks up the
  // parent chain to the filesystem root and includes any CLAUDE.md found along
  // the way (matching Claude Code's own ancestor-lookup behavior).
  //
  // Default is project-root-only because ancestor walking would pull in
  // ~/.claude/CLAUDE.md (the user's global config — typically holds personal
  // preferences, account handles, machine details). Those facts do not belong
  // in a single project's mindwright DB. Opt in explicitly when the project
  // legitimately depends on monorepo-level CLAUDE.md.
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

// Prefix of a source_ref used for the idempotency guard. Markdown sources
// emit `<path>#section-<N>` (multiple rows per file, N varies with the
// byte-budget split) so the stable per-file key is everything before
// `#section-`. Native-memory rows emit a single `memory:<file>` token with
// no section suffix — that whole token is the key. Matching on this prefix
// (rather than the consolidated long-term provenance, which retainFact
// rewrites to `drain:<id>`) lets a re-run detect "this file is already
// seeded and not yet drained" and skip it wholesale.
function sourceRefPrefix(sourceRef) {
  const i = sourceRef.indexOf('#section-');
  return i === -1 ? sourceRef : sourceRef.slice(0, i);
}

// Hard-split a single block that exceeds maxBytes on its own. Used as a
// last-resort fallback when neither heading nor blank-line splits respect the
// budget — without this a 100 KB blank-line-free section would land in
// entries.content unchunked and silently overflow the embedder's 8192-token
// context window, embedding only the prefix and degrading recall on the tail.
//
// Walks UTF-16 *code points* (iterates the string with Array.from so an
// astral-plane codepoint — emoji, rare CJK — comes out as one element rather
// than a surrogate pair) and accumulates by their UTF-8 byte length. A naive
// slice(i, i + maxBytes) would (a) treat UTF-16 code units as the budget
// (a CJK char is 1 code unit but 3 UTF-8 bytes — 4000 code units = up to
// 12000 bytes) and (b) split a surrogate pair, leaving lone surrogates that
// the embedder encodes as U+FFFD replacement chars. Both bugs are real for
// non-English content, even though typical Latin-only docs never hit them.
function hardSplitBlock(blk, maxBytes) {
  const out = [];
  const codepoints = Array.from(blk);
  let buf = '';
  let bufBytes = 0;
  for (const cp of codepoints) {
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    // A single codepoint above the budget can't be split further — emit it
    // alone (oversized by at most 3 bytes for a 4-byte astral codepoint) so
    // the loop makes forward progress and no content is dropped.
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
    // Pre-expand any individually-oversized block via hardSplitBlock so the
    // accumulator never has to hold a chunk that already breaches the budget
    // on its own. Without this, a section that contains no blank lines
    // (e.g. a single giant code block) would emit one over-budget chunk.
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
  // Dependency gate: openStore() is the only native-dep import in this
  // script. A marketplace plugin copy (or a post-update node_modules wipe)
  // has no better-sqlite3, so check before importing it, kick off the
  // single-flight background install, and return a structured "not ready"
  // result instead of crashing at ESM load.
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
  try {
    // Collect everything first (file reads) so the SQLite transaction only
    // holds for the inserts.
    const claudeMds = collectClaudeMdAncestry(root, { includeAncestors });
    claudeMdCount = claudeMds.length;
    const readme = readIfExists(join(root, 'README.md'));
    // Native per-project memory is an ALWAYS-INCLUDED source (not a fallback):
    // these LLM-written notes re-distill through consolidation like any other
    // seed input. collectNativeMemory() returns [] when the project has no
    // native-memory tree (the common fresh-install case).
    const nativeMemory = collectNativeMemory();
    nativeMemoryFiles = nativeMemory.length;

    // Idempotency guard: a source file is skipped wholesale if ANY active
    // short `seed` row already exists under its source_ref prefix. We accept
    // staleness (an edited file is not re-chunked until its current rows are
    // drained) rather than diffing content on every run — the next dream
    // refreshes long-term anyway. Long-term rows can't satisfy this check:
    // retainFact rewrites their source_ref to `drain:<id>`, erasing the
    // origin path — so the guard is deliberately short-tier only.
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

    // Single transaction across all inserts: better-sqlite3 in WAL mode pays
    // one fsync per implicit-txn insert, so 30-100 separate inserts is
    // 30-100 fsyncs. Wrapping them collapses to one.
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
      // mtime) — the "when this memory actually happened" provenance the
      // recency invariant ranks on. CLAUDE.md/README sections stay NULL
      // event_ts (no transcript event-time → COALESCE makes them behave
      // exactly as today).
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
  } finally {
    store.close();
  }

  const readmePresent = existsSync(join(root, 'README.md'));
  // When seeded under the calling session, default `/mindwright:dream`
  // (scope=session) drains them; otherwise the user needs scope=all to
  // include the fallback session id.
  const droppedUnderCallingSession = !!callingSessionId;
  const nextStep = describeNextStep({ total, droppedUnderCallingSession, skippedFiles });

  const result = {
    ok: true,
    short_rows_inserted: total,
    claude_md_files: claudeMdCount,
    claude_md_mode: includeAncestors ? 'ancestors' : 'project-root',
    readme_present: readmePresent,
    native_memory_files: nativeMemoryFiles,
    skipped_already_seeded: skippedFiles,
    session_id: sessionId,
    next_step: nextStep,
  };
  const modeNote = includeAncestors
    ? ' (CLAUDE.md walk includes parent dirs — global ~/.claude/CLAUDE.md may be ingested)'
    : ' (CLAUDE.md scope: project root only — pass --include-ancestors to walk parent dirs)';
  process.stderr.write(`mindwright seed-from-repo — inserted ${total} short-term row(s) under session "${sessionId}"${modeNote}.\n`);
  if (total > 0) process.stderr.write(`Next: ${nextStep}\n`);
  process.stdout.write(JSON.stringify(result) + '\n');
}

// Only invoke main() when this file is executed directly (CLI), not when
// imported by unit tests that pull the helpers out.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`mindwright seed-from-repo crashed: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}
