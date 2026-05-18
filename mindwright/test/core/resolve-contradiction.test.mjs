// Coverage for mindwright_resolve_contradiction's four branches (prefer_a,
// prefer_b, merge, scope_both) plus the validation paths. Drives the same
// handlers via the scripts/mindwright.mjs CLI so schema validation and
// transactional inserts on merge/scope_both are exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliCall } from './_cli-harness.mjs';

function setupSandbox(label) {
  const dir = mkdtempSync(join(tmpdir(), `mindwright-rc-${label}-`));
  const sessionId = `mw-test-${label}-${process.pid}-${Date.now()}`;
  return {
    dir,
    sessionId,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
}

function plantTwoFacts(sb, contentA, contentB) {
  const a = cliCall('mindwright_retain',
    { content: contentA, kind: 'fact', tier: 'long', category: 'fact', scope: 'project' },
    { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
  const b = cliCall('mindwright_retain',
    { content: contentB, kind: 'fact', tier: 'long', category: 'fact', scope: 'project' },
    { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
  // ids may come back as strings (BigInt) — Number() is safe up to 2^53.
  return { aId: Number(a.id), bId: Number(b.id) };
}

function statusCounts(sb) {
  const s = cliCall('mindwright_status', {}, { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
  return s;
}

// ---------------------------------------------------------------
// prefer_a / prefer_b
// ---------------------------------------------------------------

test('resolve_contradiction prefer_a archives b but keeps a', async () => {
  const sb = setupSandbox('prefer-a');
  try {
    const { aId, bId } = plantTwoFacts(
      sb,
      'auth uses bcrypt cost factor 12',
      'auth uses bcrypt cost factor 10',
    );
    const before = statusCounts(sb);
    assert.equal(before.long_count, 2);

    const out = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: bId, resolution: 'prefer_a' },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    assert.equal(out.resolution, 'prefer_a');

    const after = statusCounts(sb);
    assert.equal(after.long_count, 1, 'expect b archived, only a active');

    // Audit invariant: the loser (b) must record a supersede edge pointing
    // at the winner (a) with reason='prefer_a'. Otherwise the row simply
    // vanishes from the active set with no trace of why or what replaced it.
    const { openStore } = await import('../../lib/store.js');
    const store = openStore({ path: `${sb.dir}/.claude/mindwright/mindwright.db`, readonly: true });
    try {
      const parents = store.supersedeParents(aId);
      const supersededOf = parents.map((p) => Number(p.old_id));
      assert.ok(supersededOf.includes(bId),
        `prefer_a must record b -> a in entry_supersedes; got parents=${JSON.stringify(parents)}`);
      const edge = parents.find((p) => Number(p.old_id) === bId);
      assert.equal(edge.reason, 'prefer_a');
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction prefer_b archives a but keeps b', async () => {
  const sb = setupSandbox('prefer-b');
  try {
    const { aId, bId } = plantTwoFacts(
      sb,
      'old: deploy to staging via blue-green',
      'new: deploy to staging via canary rollout',
    );
    const out = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: bId, resolution: 'prefer_b' },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    assert.equal(out.resolution, 'prefer_b');

    const after = statusCounts(sb);
    assert.equal(after.long_count, 1, 'expect a archived, only b active');

    // Symmetric audit invariant: the loser (a) must record a supersede edge
    // pointing at the winner (b) with reason='prefer_b'.
    const { openStore } = await import('../../lib/store.js');
    const store = openStore({ path: `${sb.dir}/.claude/mindwright/mindwright.db`, readonly: true });
    try {
      const parents = store.supersedeParents(bId);
      const supersededOf = parents.map((p) => Number(p.old_id));
      assert.ok(supersededOf.includes(aId),
        `prefer_b must record a -> b in entry_supersedes; got parents=${JSON.stringify(parents)}`);
      const edge = parents.find((p) => Number(p.old_id) === aId);
      assert.equal(edge.reason, 'prefer_b');
    } finally {
      store.close();
    }
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------
// merge — transactional insert + 2 supersede links
// ---------------------------------------------------------------

test('resolve_contradiction merge inserts a new row and supersedes both originals', async () => {
  const sb = setupSandbox('merge');
  try {
    const { aId, bId } = plantTwoFacts(
      sb,
      'queue worker uses 4 threads',
      'queue worker uses 8 threads',
    );
    const out = cliCall('mindwright_resolve_contradiction',
      {
        fact_id_a: aId,
        fact_id_b: bId,
        resolution: 'merge',
        merged_content: 'queue worker uses 8 threads (raised from 4 after load test)',
      },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    assert.equal(out.resolution, 'merge');
    assert.ok(out.merged_id, 'merge must return merged_id');

    // Both originals are now archived; merged_id is the only active row.
    const after = statusCounts(sb);
    assert.equal(after.long_count, 1, 'expect both originals archived, merged active');

    // The merged row's supersede graph must include BOTH originals — the
    // single-column entries.supersedes can only point at one parent (the
    // last-written one), so we read entry_supersedes directly to confirm
    // both A and B are recorded.
    const { openStore } = await import('../../lib/store.js');
    const store = openStore({ path: `${sb.dir}/.claude/mindwright/mindwright.db`, readonly: true });
    try {
      const parents = store.supersedeParents(Number(out.merged_id));
      const oldIds = parents.map((p) => Number(p.old_id)).sort((a, b) => a - b);
      const expected = [aId, bId].sort((a, b) => a - b);
      assert.deepEqual(oldIds, expected, 'merge must record BOTH originals in entry_supersedes');
      // Each row carries the reason tag.
      for (const p of parents) {
        assert.equal(p.reason, 'merge');
      }
    } finally {
      try { store.close(); } catch { /* tmp */ }
    }
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction rejects same-id case (fact_id_a === fact_id_b) on every resolution branch', async () => {
  // Regression: a caller typo where fact_id_a === fact_id_b would silently
  // corrupt state. scope_both inserted two near-identical scoped rows and
  // double-stamped the supersedes pointer on the single archived original;
  // prefer_a/prefer_b would hit the entries.supersedes CHECK with a non-obvious
  // SQLite error after wrapping into the JSON-RPC reply. Reject at handler entry.
  const sb = setupSandbox('same-id');
  try {
    const { aId } = plantTwoFacts(sb, 'fact-a', 'fact-b'); // bId unused
    for (const resolution of ['prefer_a', 'prefer_b', 'merge', 'scope_both']) {
      const args = { fact_id_a: aId, fact_id_b: aId, resolution };
      if (resolution === 'merge') args.merged_content = 'merged';
      if (resolution === 'scope_both') {
        args.scope_a = 's_a';
        args.scope_b = 's_b';
      }
      const raw = cliCall('mindwright_resolve_contradiction', args, { projectRoot: sb.dir, sessionId: sb.sessionId });
      assert.ok(raw.isError, `${resolution}: must reject same-id`);
      const body = raw.payload;
      assert.match(body.error, /must be different/i, `${resolution}: error must explain same-id rejection`);
    }
    // No active row was archived and no new scoped/merged rows were inserted
    // (long_count still 2 — the two facts we planted).
    const after = statusCounts(sb);
    assert.equal(after.long_count, 2, 'no row should have been archived by any same-id call');
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction merge without merged_content returns error', async () => {
  const sb = setupSandbox('merge-missing');
  try {
    const { aId, bId } = plantTwoFacts(sb, 'fact-a', 'fact-b');
    const raw = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: bId, resolution: 'merge' },
      { projectRoot: sb.dir, sessionId: sb.sessionId });
    assert.ok(raw.isError, 'response must signal error');
    const body = raw.payload;
    assert.match(body.error, /merged_content/i);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------
// scope_both — transactional 2 inserts + 2 supersedes
// ---------------------------------------------------------------

test('resolve_contradiction scope_both inserts two scope-suffixed rows + supersedes', async () => {
  const sb = setupSandbox('scope-both');
  try {
    const { aId, bId } = plantTwoFacts(
      sb,
      'we use jest for unit tests',
      'we use vitest for unit tests',
    );
    const out = cliCall('mindwright_resolve_contradiction',
      {
        fact_id_a: aId,
        fact_id_b: bId,
        resolution: 'scope_both',
        scope_a: 'on the legacy frontend repo',
        scope_b: 'on the new mindwright repo',
      },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    assert.equal(out.resolution, 'scope_both');
    assert.ok(out.new_id_a, 'scope_both must return new_id_a');
    assert.ok(out.new_id_b, 'scope_both must return new_id_b');
    assert.notEqual(out.new_id_a, out.new_id_b);

    // Originals archived (2), new scoped rows active (2) → long_count = 2.
    const after = statusCounts(sb);
    assert.equal(after.long_count, 2);
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction scope_both strips trailing qualifier even when the scope description contains parens', async () => {
  // Bug regression: the original stripScopeQualifier regex used [^)]* and
  // stopped at the FIRST `)`, so a scope description like "running tests (CI)"
  // left a `(CI))` fragment behind. A subsequent scope_both call would then
  // stack a new qualifier on top of the unstripped fragment.
  const sb = setupSandbox('scope-nested-parens');
  try {
    const { aId, bId } = plantTwoFacts(
      sb,
      'use jest for unit tests',
      'use vitest for unit tests',
    );
    // First pass: scope_a contains nested parens.
    const first = cliCall('mindwright_resolve_contradiction',
      {
        fact_id_a: aId,
        fact_id_b: bId,
        resolution: 'scope_both',
        scope_a: 'running tests (CI)',
        scope_b: 'running tests (local)',
      },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    // Second pass: must REPLACE, not stack, despite the nested parens.
    const second = cliCall('mindwright_resolve_contradiction',
      {
        fact_id_a: first.new_id_a,
        fact_id_b: first.new_id_b,
        resolution: 'scope_both',
        scope_a: 'node 22',
        scope_b: 'node 24',
      },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    const sqlite = await import('better-sqlite3');
    const path = await import('node:path');
    const dbPath = path.join(sb.dir, '.claude', 'mindwright', 'mindwright.db');
    const db = new sqlite.default(dbPath, { readonly: true });
    try {
      const rowA = db.prepare('SELECT content FROM entries WHERE id = ?').get(BigInt(second.new_id_a));
      const rowB = db.prepare('SELECT content FROM entries WHERE id = ?').get(BigInt(second.new_id_b));
      const matchesA = rowA.content.match(/\(applies when:/g) || [];
      const matchesB = rowB.content.match(/\(applies when:/g) || [];
      assert.equal(matchesA.length, 1, `expected one qualifier in A, got ${matchesA.length}: ${rowA.content}`);
      assert.equal(matchesB.length, 1, `expected one qualifier in B, got ${matchesB.length}: ${rowB.content}`);
      assert.match(rowA.content, /\(applies when: node 22\)/);
      assert.match(rowB.content, /\(applies when: node 24\)/);
      // No leftover fragments from the old scope description.
      assert.ok(!/CI/.test(rowA.content), `'CI' fragment must be gone: ${rowA.content}`);
      assert.ok(!/local/.test(rowB.content), `'local' fragment must be gone: ${rowB.content}`);
    } finally {
      db.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction scope_both is idempotent — re-scoping a scoped fact REPLACES the qualifier (no stacking)', async () => {
  // Behavior regression: stacking "(applies when: ...)" suffixes turned a
  // fact's body into nonsense after a second scope_both pass:
  //   "we use jest. \n\n(applies when: legacy)\n\n(applies when: new)"
  // The fix strips a trailing scope qualifier before appending the new one.
  const sb = setupSandbox('scope-idempotent');
  try {
    const { aId, bId } = plantTwoFacts(
      sb,
      'we use jest for unit tests',
      'we use vitest for unit tests',
    );

    // First scope_both: produces two scoped rows.
    const first = cliCall('mindwright_resolve_contradiction',
      {
        fact_id_a: aId,
        fact_id_b: bId,
        resolution: 'scope_both',
        scope_a: 'legacy frontend repo',
        scope_b: 'new mindwright repo',
      },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;
    const scopedA1 = first.new_id_a;
    const scopedB1 = first.new_id_b;

    // Second scope_both on the SAME pair of scoped rows — simulate the
    // user surfacing a new contradiction-context. Without the strip this
    // would stack "(applies when:...)" twice.
    const second = cliCall('mindwright_resolve_contradiction',
      {
        fact_id_a: scopedA1,
        fact_id_b: scopedB1,
        resolution: 'scope_both',
        scope_a: 'when running on Node 22',
        scope_b: 'when running on Node 24',
      },
      { projectRoot: sb.dir, sessionId: sb.sessionId }).payload;

    // Read the resulting rows directly to verify the content. The MCP
    // client doesn't expose a fetch-by-id tool, so peek at SQLite.
    const sqlite = await import('better-sqlite3');
    const path = await import('node:path');
    const dbPath = path.join(sb.dir, '.claude', 'mindwright', 'mindwright.db');
    const db = new sqlite.default(dbPath, { readonly: true });
    try {
      const rowA = db.prepare('SELECT content FROM entries WHERE id = ?').get(BigInt(second.new_id_a));
      const rowB = db.prepare('SELECT content FROM entries WHERE id = ?').get(BigInt(second.new_id_b));
      // Each body should contain EXACTLY ONE "(applies when: ...)" line.
      const matchesA = rowA.content.match(/\(applies when:/g) || [];
      const matchesB = rowB.content.match(/\(applies when:/g) || [];
      assert.equal(matchesA.length, 1, `expected one qualifier, got ${matchesA.length} in: ${rowA.content}`);
      assert.equal(matchesB.length, 1, `expected one qualifier, got ${matchesB.length} in: ${rowB.content}`);
      // And the new qualifier wins.
      assert.match(rowA.content, /\(applies when: when running on Node 22\)/);
      assert.match(rowB.content, /\(applies when: when running on Node 24\)/);
      assert.ok(!/legacy frontend repo/.test(rowA.content), 'old qualifier must be gone');
    } finally {
      db.close();
    }
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction scope_both without scope_a returns error', async () => {
  const sb = setupSandbox('scope-missing-a');
  try {
    const { aId, bId } = plantTwoFacts(sb, 'fact-a', 'fact-b');
    const raw = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: bId, resolution: 'scope_both', scope_b: 'b' },
      { projectRoot: sb.dir, sessionId: sb.sessionId });
    assert.ok(raw.isError);
    const body = raw.payload;
    assert.match(body.error, /scope_a/);
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction scope_both without scope_b returns error', async () => {
  const sb = setupSandbox('scope-missing-b');
  try {
    const { aId, bId } = plantTwoFacts(sb, 'fact-a', 'fact-b');
    const raw = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: bId, resolution: 'scope_both', scope_a: 'a' },
      { projectRoot: sb.dir, sessionId: sb.sessionId });
    assert.ok(raw.isError);
    const body = raw.payload;
    assert.match(body.error, /scope_b/);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------
// validation edges
// ---------------------------------------------------------------

test('resolve_contradiction unknown resolution returns error', async () => {
  const sb = setupSandbox('unknown-resolution');
  try {
    const { aId, bId } = plantTwoFacts(sb, 'fact-a', 'fact-b');
    const raw = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: bId, resolution: 'spaghetti' },
      { projectRoot: sb.dir, sessionId: sb.sessionId });
    // The MCP SDK passes arguments through without enforcing the JSON
    // Schema enum at the wire layer — the handler's default case in the
    // switch on `resolution` is what produces the error. Pin BOTH the
    // wire-level flag and the error text so a regression that drops the
    // default case (silently treating an unknown enum as a no-op) is
    // caught instead of being absorbed by an "either branch passes"
    // tolerance.
    assert.equal(raw.isError, true, 'unknown resolution must mark the response as isError=true');
    const body = raw.payload;
    assert.match(body.error, /resolution must be prefer_a \| prefer_b \| merge \| scope_both/,
      `expected the handler's default-case message; got ${JSON.stringify(body)}`);
  } finally {
    sb.cleanup();
  }
});

test('resolve_contradiction non-existent fact_id returns "not found"', async () => {
  const sb = setupSandbox('fact-missing');
  try {
    const { aId } = plantTwoFacts(sb, 'fact-a', 'fact-b');
    const raw = cliCall('mindwright_resolve_contradiction',
      { fact_id_a: aId, fact_id_b: 99999, resolution: 'prefer_a' },
      { projectRoot: sb.dir, sessionId: sb.sessionId });
    assert.ok(raw.isError);
    const body = raw.payload;
    assert.match(body.error, /not found/i);
  } finally {
    sb.cleanup();
  }
});
