// Unit tests for the three non-trivial helpers inside scripts/seed-from-repo.js.
// The existing seed-from-repo.test.js drives the happy path end-to-end; this
// file pins the branches that the e2e test never reaches:
//   - findCallingSessionId (ticket discovery + PID-liveness filter)
//   - collectClaudeMdAncestry (multi-level CLAUDE.md walk)
//   - splitMarkdownSections (heading split + large-section subdivision)
// A regression in any of these would silently degrade /mindwright:dream's
// input (sections chunked mid-sentence, rows landing under the wrong
// session id) without surfacing in the spawn-the-script integration test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findCallingSessionId,
  collectClaudeMdAncestry,
  splitMarkdownSections,
} from '../../scripts/seed-from-repo.js';
import { ticketsDir } from '../../lib/paths.js';

// Async-aware: if fn returns a Promise, defer cleanup until it settles so
// the rmSync doesn't race with in-flight async work (e.g. findCallingSessionId
// now reads tickets via node:fs/promises).
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-seed-helpers-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const restore = () => {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  };
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { restore(); return v; },
      (err) => { restore(); throw err; },
    );
  }
  restore();
  return result;
}

// A reliably-dead PID: spawn a child, let it exit, reuse its reaped pid.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// readActiveTicket now gates on claude_pid liveness (alive → eligible) and
// returns the session_id of the most-recent `created_at` among eligible
// tickets — no mtime, no heartbeat. `ageMs` only backdates created_at to
// control recency ordering; `alive: false` plants a genuine dead-PID ticket
// (the "stale" case is a crashed session now, not an aged file). A live
// ticket uses THIS process's pid (guaranteed alive on every platform for the
// duration of the test); vary `hookPid` to keep co-live tickets in distinct
// files (the path is `${claude_pid}-${hook_pid}.json`).
function plantTicket({
  sessionId, ageMs = 0, alive = true, hookPid = 67890,
}) {
  const dir = ticketsDir();
  mkdirSync(dir, { recursive: true });
  const claudePid = alive ? process.pid : deadPid();
  const ticket = {
    session_id: sessionId,
    claude_pid: claudePid,
    hook_pid: hookPid,
    created_at: Date.now() - ageMs,
  };
  const path = join(dir, `${claudePid}-${hookPid}.json`);
  writeFileSync(path, JSON.stringify(ticket));
}

// ---------------------------------------------------------------
// findCallingSessionId
// ---------------------------------------------------------------

test('findCallingSessionId returns null when no tickets dir exists', async () => {
  await withTmp(async () => {
    // No tickets at all — function must not throw, must return null.
    assert.equal(await findCallingSessionId(), null);
  });
});

test('findCallingSessionId returns the most-recent live ticket session_id', async () => {
  await withTmp(async () => {
    // Both tickets have a live PID (this process); recency is decided by
    // created_at — newer-sess (ageMs 0) beats older-sess (ageMs 1000).
    plantTicket({ sessionId: 'older-sess', ageMs: 1_000, hookPid: 1 });
    plantTicket({ sessionId: 'newer-sess', ageMs: 0, hookPid: 2 });
    assert.equal(await findCallingSessionId(), 'newer-sess');
  });
});

test('findCallingSessionId ignores a ticket whose claude_pid is dead (crashed session)', async () => {
  await withTmp(async () => {
    // Age is irrelevant now: a freshly-written ticket with a dead PID is a
    // crashed/never-spawned session and must not bind the seed rows.
    plantTicket({ sessionId: 'dead-sess', alive: false });
    assert.equal(await findCallingSessionId(), null);
  });
});

test('findCallingSessionId tolerates unparseable / partial ticket files', async () => {
  await withTmp(async () => {
    const dir = ticketsDir();
    mkdirSync(dir, { recursive: true });
    // Garbage file.
    writeFileSync(join(dir, '999-1.json'), '{ not valid json');
    // Tmp partial.
    writeFileSync(join(dir, '999-2.json.tmp.1234'), '{}');
    // One valid live ticket.
    plantTicket({ sessionId: 'survivor', hookPid: 1 });
    assert.equal(await findCallingSessionId(), 'survivor');
  });
});

// ---------------------------------------------------------------
// collectClaudeMdAncestry
// ---------------------------------------------------------------

test('collectClaudeMdAncestry returns empty when no CLAUDE.md found', () => {
  withTmp((root) => {
    const out = collectClaudeMdAncestry(root);
    assert.deepEqual(out, []);
  });
});

test('collectClaudeMdAncestry finds CLAUDE.md at the start directory', () => {
  withTmp((root) => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\nProject rules.\n');
    const out = collectClaudeMdAncestry(root);
    assert.equal(out.length, 1);
    assert.match(out[0].path, /CLAUDE\.md$/);
    assert.match(out[0].body, /Project rules\./);
  });
});

test('collectClaudeMdAncestry default (no flag) does NOT walk parent dirs', () => {
  // Regression for the privacy issue: a project's CLAUDE.md must NOT pull in
  // the user's global ~/.claude/CLAUDE.md or other ancestor configs by
  // default. The default behavior is project-root-only; opt-in to ancestor
  // walking is gated behind `{ includeAncestors: true }`.
  withTmp((root) => {
    const child = join(root, 'sub', 'deeper');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# Outer\nouter rules\n');
    writeFileSync(join(child, 'CLAUDE.md'), '# Inner\ninner rules\n');
    const out = collectClaudeMdAncestry(child);
    assert.equal(out.length, 1,
      `default must collect only the start dir, got ${out.length}: ${JSON.stringify(out.map((o) => o.path))}`);
    assert.match(out[0].body, /inner rules/);
    assert.ok(!out.some((entry) => /outer rules/.test(entry.body)),
      'outer CLAUDE.md must NOT be collected without --include-ancestors');
  });
});

test('collectClaudeMdAncestry walks up and finds multiple CLAUDE.md files when includeAncestors=true', () => {
  withTmp((root) => {
    const child = join(root, 'sub', 'deeper');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# Outer\nouter rules\n');
    writeFileSync(join(child, 'CLAUDE.md'), '# Inner\ninner rules\n');
    const out = collectClaudeMdAncestry(child, { includeAncestors: true });
    // First entry is the nearest ancestor (the start dir), subsequent are higher up.
    assert.ok(out.length >= 2, `expected >=2, got ${out.length}`);
    assert.match(out[0].body, /inner rules/);
    assert.ok(out.some((entry) => /outer rules/.test(entry.body)), 'must also find the outer CLAUDE.md');
  });
});

// ---------------------------------------------------------------
// splitMarkdownSections
// ---------------------------------------------------------------

test('splitMarkdownSections returns one section per top-level heading on small body', () => {
  const body = `# Intro\nHello world.\n\n# Setup\nRun npm install.\n\n# Usage\nCall the tool.\n`;
  const out = splitMarkdownSections(body);
  assert.equal(out.length, 3, `expected 3 sections, got ${out.length}`);
  assert.match(out[0], /^# Intro/);
  assert.match(out[1], /^# Setup/);
  assert.match(out[2], /^# Usage/);
});

test('splitMarkdownSections treats a heading-less body as a single section', () => {
  const body = 'just some prose\n\nno markers here\n';
  const out = splitMarkdownSections(body);
  assert.equal(out.length, 1);
  assert.match(out[0], /just some prose/);
});

test('splitMarkdownSections subdivides a section larger than maxBytes on blank lines', () => {
  // Build one heading-section whose body alone is well over the cap. Use
  // blank-line-separated blocks so the splitter has natural break points.
  const block = 'a'.repeat(800);
  const body = `# Big\n${block}\n\n${block}\n\n${block}\n\n${block}\n\n${block}\n\n${block}`;
  const out = splitMarkdownSections(body, 1000);
  // 6 * 800-char blocks under a 1000-byte cap → must split into multiple parts.
  assert.ok(out.length > 1, `expected multiple chunks, got ${out.length}`);
  for (const chunk of out) {
    assert.ok(
      Buffer.byteLength(chunk, 'utf8') <= 1000 + 800,
      `chunk byte length ${Buffer.byteLength(chunk, 'utf8')} should not greatly exceed cap`,
    );
  }
});

test('splitMarkdownSections preserves all content across splits (no data loss)', () => {
  const block = 'b'.repeat(500);
  const body = `# Lossless\n${block}\n\n${block}\n\n${block}`;
  const out = splitMarkdownSections(body, 600);
  const joined = out.join('');
  // Every original block must still appear in the concatenation.
  const blockCount = (joined.match(/b{500}/g) || []).length;
  assert.equal(blockCount, 3, 'must keep all three b-blocks across the split');
});

test('splitMarkdownSections skips empty sections (no whitespace-only entries)', () => {
  const body = `\n\n# Real\nbody\n`;
  const out = splitMarkdownSections(body);
  assert.equal(out.length, 1);
  assert.match(out[0], /^# Real/);
});

test('splitMarkdownSections hard-splits a multibyte (CJK) block by BYTES, not code units', () => {
  // Regression: an earlier impl used blk.slice(i, i+maxBytes), treating UTF-16
  // code units as the budget. A single CJK char is 1 code unit but 3 UTF-8
  // bytes, so a 4000-code-unit slice could land at 12000 bytes — silently
  // overflowing the embedder context. Verify the byte cap holds for CJK.
  const cjk = '日'.repeat(3_000); // 3 bytes each → 9000 bytes total
  const body = `# CJK\n${cjk}`;
  const out = splitMarkdownSections(body, 1_000);
  for (const chunk of out) {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    assert.ok(bytes <= 1_000, `chunk is ${bytes} bytes, exceeds 1000-byte cap`);
  }
  const totalCjk = out.reduce((acc, c) => acc + (c.match(/日/g) || []).length, 0);
  assert.equal(totalCjk, 3_000, `must preserve all 3000 CJK chars; got ${totalCjk}`);
});

test('splitMarkdownSections never splits a surrogate pair (astral codepoints stay whole)', () => {
  // Regression: blk.slice(i, i+N) could land inside a surrogate pair (an
  // astral codepoint occupies 2 UTF-16 code units). Each lone surrogate
  // encodes to U+FFFD on toString('utf8'), so the embedder sees garbage
  // where the user wrote an emoji. The fix walks code points, never half.
  const rocket = '🚀'; // U+1F680, 4 UTF-8 bytes, 2 UTF-16 code units
  const body = `# Emoji\n${rocket.repeat(500)}`; // 2000 bytes of rockets
  const out = splitMarkdownSections(body, 100);
  const replacementChars = out.join('').match(/�/g) || [];
  assert.equal(replacementChars.length, 0, 'no surrogate-half left as U+FFFD');
  const totalRockets = out.reduce((acc, c) => acc + (c.match(/🚀/g) || []).length, 0);
  assert.equal(totalRockets, 500, `must preserve all 500 rockets; got ${totalRockets}`);
});

test('splitMarkdownSections hard-splits a single blank-line-free block exceeding maxBytes', () => {
  // Regression: a section without any \n\s*\n boundary (e.g. a long code block
  // or unbroken paragraph) used to emit one over-budget chunk because the
  // accumulator's `&& buf` short-circuit lets `buf = blk` when buf=''. Without
  // hard-split fallback, the row would feed unchunked into the embedder and
  // silently truncate at the bge-m3 8192-token window.
  const huge = 'z'.repeat(50_000); // single block, NO blank line inside
  const body = `# Long\n${huge}`;
  const out = splitMarkdownSections(body, 4_000);
  // Every chunk must respect the budget — char length is a valid upper bound
  // since one UTF-8 char is at least one byte.
  for (const chunk of out) {
    assert.ok(
      Buffer.byteLength(chunk, 'utf8') <= 4_000,
      `chunk byte length ${Buffer.byteLength(chunk, 'utf8')} exceeds 4000-byte cap`,
    );
  }
  // No data loss — every z must still be accounted for somewhere.
  const totalZs = out.reduce((acc, c) => acc + (c.match(/z/g) || []).length, 0);
  assert.equal(totalZs, 50_000, `must preserve all 50000 z chars; got ${totalZs}`);
});
