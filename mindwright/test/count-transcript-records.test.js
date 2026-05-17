// Direct unit tests for countTranscriptRecords, exported from lib/offset-init.js
// (Step 7 relocated it there from hooks/session-start-impl.js together with the
// offset-init decision it serves, so the flush backstop and SessionStart share
// one definition). Unit-testing it directly exercises the newline-count +
// best-effort failure branches without spawning the SessionStart hook
// subprocess (mirrors test/novelty-gate.test.js's relationship to
// pre-tool-use-impl.js). The session-start subprocess tests in
// test/hooks/hooks.test.js only ever feed it well-formed, deps-present
// transcripts, so the error→null branch and the resolve-exactly-once contract
// were unasserted.
//
// Scope note: the `settled` latch also guards the theoretical case of a stream
// emitting BOTH 'error' and 'end'. Node guarantees a single terminal event on
// a real file stream, and a Promise settles once by spec, so that synthetic
// double-emit is not inducible through the public file API. Adding a
// createReadStream injection seam purely to fire it would be disproportionate
// for an unreachable defensive guard; instead the observable contract it
// protects — exactly one resolved value, correct per terminal event — is
// pinned by the end-path and error-path tests below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTranscriptRecords } from '../lib/offset-init.js';

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-ctr-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('countTranscriptRecords: empty file resolves to 0', async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');

    const n = await countTranscriptRecords(p);

    assert.equal(n, 0);
  });
});

test('countTranscriptRecords: counts one record per newline (trailing newline)', async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, 'three.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\n{"c":3}\n');

    const n = await countTranscriptRecords(p);

    assert.equal(n, 3);
  });
});

test('countTranscriptRecords: a final line with no trailing newline is not counted (newline-delimited semantics)', async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, 'no-trailing.jsonl');
    writeFileSync(p, 'line1\nline2');

    const n = await countTranscriptRecords(p);

    assert.equal(n, 1);
  });
});

test('countTranscriptRecords: nonexistent path resolves to null (best-effort error branch, never rejects)', async () => {
  await withTmpDir(async (dir) => {
    const missing = join(dir, 'does-not-exist.jsonl');

    // Must resolve (not reject) — the caller awaits it without a try/catch and
    // the warning falls back to a byte-only message when the count is null.
    const result = await countTranscriptRecords(missing);

    assert.equal(result, null);
  });
});

test('countTranscriptRecords: the success (end-of-stream) path resolves with a numeric count and never rejects', async () => {
  // Success-path mirror of the error-path test above: the caller in
  // lib/offset-init.js does `await countTranscriptRecords(...)` with NO
  // try/catch, so BOTH terminal events must RESOLVE — the error event with
  // null, and (here) the normal 'end' event with a numeric count — never
  // reject. (The `settled` latch's extra double-emit guard is, per the header
  // note, unreachable through the public file API and deliberately not
  // seam-tested; this pins only the observable end-path resolve discipline.)
  await withTmpDir(async (dir) => {
    const p = join(dir, 'records.jsonl');
    writeFileSync(p, 'a\nb\n');

    const v = await countTranscriptRecords(p);

    assert.equal(v, 2);
    assert.equal(typeof v, 'number');
  });
});
