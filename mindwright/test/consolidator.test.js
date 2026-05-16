// Consolidator tests — drain → retain → finalize cycle. Mocks the LLM by hand-
// crafting the facts that a real session would emit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import {
  drainBatch,
  retainFact,
  markSuperseded,
  finalizeDrain,
  groupIntoExchanges,
} from '../lib/consolidator.js';
import { mirrorsDir } from '../lib/paths.js';

async function withStore(fn) {
  // Snapshot MINDWRIGHT_PROJECT_ROOT so tests run after this one don't
  // inherit a dangling path that points at a tmp dir we've already removed.
  // Mirrors the prev/restore pattern in test/paths.test.js.
  const prevProjectRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-cns-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  const store = openStore();
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevProjectRoot === undefined) {
      delete process.env.MINDWRIGHT_PROJECT_ROOT;
    } else {
      process.env.MINDWRIGHT_PROJECT_ROOT = prevProjectRoot;
    }
  }
}

function unit(seed) {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.cos(seed * (i + 1));
  let n = 0;
  for (let i = 0; i < 1024; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 1024; i++) v[i] /= n;
  return v;
}

const stubEmbed = async (texts) => texts.map((t, i) => unit(t.length + i + 1));

test('drainBatch returns empty when no short-term rows', async () => {
  await withStore((store) => {
    const out = drainBatch({ store });
    assert.equal(out.exchanges.length, 0);
    assert.equal(out.drain_id, null);
  });
});

test('drainBatch picks the oldest drain_pct fraction', async () => {
  await withStore((store) => {
    for (let i = 0; i < 10; i++) {
      store.insertEntry({ tier: 'short', kind: 'thinking', content: `obs ${i}`, sessionId: 's' });
    }
    const out = drainBatch({ store, sessionId: 's', drainPct: 0.5 });
    assert.equal(out.drained_count, 5);
    // Drained the OLDEST half — sniff via summed content positions.
    const drainedContents = out.exchanges.flatMap((e) => e.rows).map((r) => r.content);
    assert.ok(drainedContents.includes('obs 0'));
    assert.ok(!drainedContents.includes('obs 9'));
  });
});

test('groupIntoExchanges opens new exchanges on opener kinds', () => {
  const rows = [
    { id: 1, kind: 'cli_prompt', content: 'first prompt', created_at: '1' },
    { id: 2, kind: 'thinking', content: 'thinking about it', created_at: '2' },
    { id: 3, kind: 'text', content: 'replying', created_at: '3' },
    { id: 4, kind: 'cli_prompt', content: 'second prompt', created_at: '4' },
    { id: 5, kind: 'thinking', content: 'more thinking', created_at: '5' },
  ];
  const ex = groupIntoExchanges(rows);
  assert.equal(ex.length, 2);
  assert.equal(ex[0].rows.length, 3);
  assert.equal(ex[1].rows.length, 2);
});

test('groupIntoExchanges treats handoff/finding/blocker/decision as openers', () => {
  const rows = [
    { id: 1, kind: 'thinking', content: 't', created_at: '1' },
    { id: 2, kind: 'handoff', content: 'h', created_at: '2' },
    { id: 3, kind: 'text', content: 'tx', created_at: '3' },
    { id: 4, kind: 'finding', content: 'f', created_at: '4' },
    { id: 5, kind: 'blocker', content: 'b', created_at: '5' },
    { id: 6, kind: 'decision', content: 'd', created_at: '6' },
  ];
  const ex = groupIntoExchanges(rows);
  // openers at indexes 2, 4, 5, 6 → 4 exchanges (plus the initial 't' exchange opened by no opener: it becomes the first exchange when current is null)
  assert.equal(ex.length, 5);
});

test('groupIntoExchanges soft-splits oversized exchanges', () => {
  const big = 'x'.repeat(20_000);
  const rows = [
    { id: 1, kind: 'cli_prompt', content: 'open', created_at: '1' },
    { id: 2, kind: 'thinking', content: big, created_at: '2' },
    { id: 3, kind: 'thinking', content: big, created_at: '3' },
  ];
  const ex = groupIntoExchanges(rows, 12_000);
  assert.ok(ex.length >= 2, `expected soft-split, got ${ex.length} exchanges`);
});

test('groupIntoExchanges soft-split parts share a base id and use part suffixes', () => {
  // Regression: a previous version incremented exchange_id on soft-split,
  // so two halves of one logical conversation looked like independent
  // exchanges to the consolidator skill (and cross-half supersede detection
  // missed the link). The fix is to keep the base id and append "-partN".
  const big = 'x'.repeat(20_000);
  const rows = [
    { id: 1, kind: 'cli_prompt', content: 'open A', created_at: '1' },
    { id: 2, kind: 'thinking', content: big, created_at: '2' },
    { id: 3, kind: 'thinking', content: big, created_at: '3' },
    { id: 4, kind: 'cli_prompt', content: 'open B', created_at: '4' },
    { id: 5, kind: 'thinking', content: 'small', created_at: '5' },
  ];
  const ex = groupIntoExchanges(rows, 12_000);
  // First exchange split into parts.
  const partsOfFirst = ex.filter((e) => /^ex-0(-part\d+)?$/.test(e.exchange_id));
  assert.ok(partsOfFirst.length >= 2, `expected soft-split of ex-0; got ids: ${ex.map((e) => e.exchange_id).join(', ')}`);
  assert.equal(partsOfFirst[0].exchange_id, 'ex-0', 'first part must keep bare ex-0 id');
  assert.match(partsOfFirst[1].exchange_id, /^ex-0-part2$/, 'second part must be ex-0-part2');
  // Second exchange is a fresh logical thread → fresh base id.
  const secondBase = ex.find((e) => e.exchange_id === 'ex-1');
  assert.ok(secondBase, `expected ex-1 from second cli_prompt; got ids: ${ex.map((e) => e.exchange_id).join(', ')}`);
});

test('retainFact inserts a long-term row with embedding + entities', async () => {
  await withStore(async (store) => {
    const { fact_id } = await retainFact({
      store,
      content: 'the user prefers tabs and edits lib/store.js often',
      category: 'fact', scope: 'user',
      confidence: 0.8,
      embed: stubEmbed,
    });
    const row = store.fetch(fact_id);
    assert.equal(row.tier, 'long');
    assert.equal(row.category, 'fact');
    assert.equal(row.scope, 'user');
    assert.equal(row.confidence, 0.8);
    // entity link present
    const ent = store.db.prepare(`
      SELECT ent.name, ent.kind FROM entry_entities ee
        JOIN entities ent ON ent.id = ee.entity_id
       WHERE ee.entry_id = ?
    `).all(fact_id);
    assert.ok(ent.some((e) => e.name === 'lib/store.js' && e.kind === 'file_path'));
  });
});

test('retainFact handles missing embed fn — row gets embedding=NULL', async () => {
  await withStore(async (store) => {
    const { fact_id } = await retainFact({
      store,
      content: 'no-embedder path',
      category: 'fact', scope: 'project',
    });
    const row = store.fetch(fact_id);
    assert.equal(row.tier, 'long');
    const vecRow = store.db.prepare('SELECT rowid FROM vec_index WHERE rowid = ?').get(fact_id);
    assert.equal(vecRow, undefined);
  });
});

test('retainFact surfaces supersede candidates', async () => {
  await withStore(async (store) => {
    // Plant a long-term row first.
    const old = await retainFact({
      store,
      content: 'the user prefers spaces for indentation',
      category: 'fact', scope: 'user',
      embed: stubEmbed,
    });
    // Now add a closely-related new fact.
    const fresh = await retainFact({
      store,
      content: 'the user prefers spaces for indentation in JS',
      category: 'fact', scope: 'user',
      embed: stubEmbed,
      rerank: async (q, cs) => cs.map(() => 0.9),
    });
    assert.ok(fresh.supersede_candidates.length >= 1);
    assert.ok(fresh.supersede_candidates.includes(Number(old.fact_id)));
  });
});

test('markSuperseded archives the old row and links the new one', async () => {
  await withStore(async (store) => {
    const old = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'old', sessionId: 's',
    });
    const fresh = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'user', kind: 'fact',
      content: 'new', sessionId: 's',
    });
    markSuperseded(store, old, fresh);
    assert.equal(store.fetch(old).active, 0);
    assert.equal(BigInt(store.fetch(fresh).supersedes), BigInt(old));
  });
});

test('finalizeDrain hard-deletes drained rows + records consolidation + renders mirrors', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      store.insertEntry({ tier: 'short', kind: 'thinking', content: `s${i}`, sessionId: 'sess' });
    }
    // Seed a long-term row so mirrors have something to render
    await retainFact({
      store,
      content: 'fact to render',
      category: 'fact', scope: 'project',
      embed: stubEmbed,
    });

    const drain = drainBatch({ store, sessionId: 'sess' });
    const out = finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId: 'sess',
    });
    assert.equal(out.drained_count, drain.drained_count);
    assert.ok(store.lastConsolidation());
    const factsPath = join(mirrorsDir(), 'project.md');
    assert.ok(existsSync(factsPath));
    assert.match(readFileSync(factsPath, 'utf8'), /fact to render/);
  });
});

test('finalizeDrain writes an audit archive at mirrors/dropped/ before hard-deleting', async () => {
  // Behavior regression: finalizeDrain hard-deletes the drained range even
  // when the consolidator retained zero facts from it. Without an audit
  // archive the user has no way to inspect what was discarded. The fix is
  // to write the full drained payload to mirrors/dropped/<date>-<id>.md
  // BEFORE the DELETE runs, so a mid-finalize crash also can't lose data
  // silently.
  await withStore(async (store) => {
    // 10 rows × default drainPct=0.7 → 7 rows drained, the oldest 7 by
    // (created_at,id). We check the archive against those exact ids.
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const id = store.insertEntry({
        tier: 'short', kind: 'thinking',
        content: `pre-drain content ${i} unique`, sessionId: 'archive-sess',
      });
      ids.push(id);
    }
    const drain = drainBatch({ store, sessionId: 'archive-sess' });
    assert.ok(drain.drained_count >= 7, `prep: expected ≥7 drained, got ${drain.drained_count}`);
    // Don't retain any facts — simulate the "0 facts produced" worst case.
    const out = finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId: 'archive-sess',
    });
    assert.ok(out.archive_path, `finalizeDrain must return the archive path; got: ${JSON.stringify(out)}`);
    assert.ok(existsSync(out.archive_path), `archive file must exist at ${out.archive_path}`);
    const body = readFileSync(out.archive_path, 'utf8');
    // The first drain.drained_count rows (by insertion order, which is also
    // creation order) must appear in the archive verbatim.
    for (let i = 0; i < drain.drained_count; i++) {
      assert.ok(body.includes(`pre-drain content ${i} unique`),
        `archive must contain row ${i}'s content`);
    }
    // Header should name the drain and counts.
    assert.match(body, new RegExp(`drained_count: ${drain.drained_count}`));
    assert.match(body, /produced_count: 0/);
    // Confirm the path is under <mirrorsDir>/dropped/.
    assert.match(out.archive_path, /[/\\]mirrors[/\\]dropped[/\\]/);
  });
});

test('finalizeDrain skips audit archive when MINDWRIGHT_DROPPED_ARCHIVE=off', async () => {
  const prev = process.env.MINDWRIGHT_DROPPED_ARCHIVE;
  process.env.MINDWRIGHT_DROPPED_ARCHIVE = 'off';
  try {
    await withStore(async (store) => {
      for (let i = 0; i < 4; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking', content: `c${i}`, sessionId: 'no-arch',
        });
      }
      const drain = drainBatch({ store, sessionId: 'no-arch' });
      assert.ok(drain.drained_count > 0, 'prep: drainBatch must select at least one row');
      const out = finalizeDrain({
        store,
        drainId: drain.drain_id,
        drainCutoff: drain.drain_cutoff,
        drainCutoffId: drain.drain_cutoff_id,
        sessionId: 'no-arch',
      });
      assert.equal(out.archive_path, null, 'opt-out must return archive_path=null');
      // Rows must still be hard-deleted (the user opted out of the audit, not
      // out of the drain).
      assert.equal(out.drained_count, drain.drained_count);
    });
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_DROPPED_ARCHIVE;
    else process.env.MINDWRIGHT_DROPPED_ARCHIVE = prev;
  }
});

test('finalizeDrain superseded_count reflects mark_superseded calls during the drain', async () => {
  // Behavior regression: finalizeDrain used to hardcode superseded_count: 0
  // with a comment that the calling session would report the actual count via
  // separate channels. But the /mindwright:dream skill step 7 literally says
  // "Show the user: drained N ... superseded K old facts." An LLM following
  // the skill reads superseded_count from the response and reports K=0 even
  // when it just made several mark_superseded calls. Fix: count entry_supersedes
  // rows whose new_id was produced by THIS drain (same source_ref filter as
  // produced_count) so the dream report tells the truth.
  await withStore(async (store) => {
    // Seed two pre-existing long-term rows we'll later mark superseded.
    const oldA = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'old project fact A', sessionId: 'sess',
    });
    const oldB = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'old project fact B', sessionId: 'sess',
    });
    // Seed an unrelated old fact (should NOT be counted).
    const oldC = store.insertEntry({
      tier: 'long', category: 'fact', scope: 'project', kind: 'fact',
      content: 'untouched old fact', sessionId: 'sess',
    });

    // Seed short-term so drainBatch finds something.
    for (let i = 0; i < 3; i++) {
      store.insertEntry({ tier: 'short', kind: 'thinking', content: `s${i}`, sessionId: 'sess' });
    }
    const drain = drainBatch({ store, sessionId: 'sess' });

    // Retain two new facts stamped with the drain id.
    const r1 = await retainFact({
      store, drainId: drain.drain_id,
      content: 'new fact replacing A', category: 'fact', scope: 'project',
      embed: stubEmbed, sessionId: 'sess',
    });
    const r2 = await retainFact({
      store, drainId: drain.drain_id,
      content: 'new fact replacing B', category: 'fact', scope: 'project',
      embed: stubEmbed, sessionId: 'sess',
    });

    // Mark two superseded by drain-produced facts; oldC stays untouched.
    markSuperseded(store, oldA, r1.fact_id);
    markSuperseded(store, oldB, r2.fact_id);

    const out = finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId: 'sess',
    });
    assert.equal(out.superseded_count, 2,
      `expected superseded_count=2 (two mark_superseded calls into this drain's new ids), got ${out.superseded_count}`);
    // oldC must remain active.
    assert.equal(store.fetch(oldC).active, 1);
  });
});

test('finalizeDrain produced_count excludes long-term rows from OTHER sessions', async () => {
  // Behavior regression: produced_count used to count every long-term row
  // created in the last 5 minutes globally, so a peer session's
  // /mindwright:retain in that window would inflate THIS drain's reported
  // output and mislead the user about what their own dream produced.
  await withStore(async (store) => {
    // Seed short-term in our session.
    for (let i = 0; i < 5; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking', content: `mine ${i}`, sessionId: 'mine',
      });
    }
    const drain = drainBatch({ store, sessionId: 'mine' });

    // Calling session retains one fact (sessionId='mine', drainId passed —
    // matches the production MCP handler which forwards drain_id through).
    await retainFact({
      store, drainId: drain.drain_id,
      content: 'mine fact A', category: 'fact', scope: 'project',
      embed: stubEmbed, sessionId: 'mine',
    });

    // A PARALLEL peer session retains two facts (sessionId='peer-elsewhere')
    // between drainBatch and finalizeDrain. The peer's facts must NOT be
    // attributed to our drain.
    await retainFact({
      store, content: 'peer fact 1', category: 'fact', scope: 'project',
      embed: stubEmbed, sessionId: 'peer-elsewhere',
    });
    await retainFact({
      store, content: 'peer fact 2', category: 'fact', scope: 'project',
      embed: stubEmbed, sessionId: 'peer-elsewhere',
    });

    const out = finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId: 'mine',
    });
    assert.equal(out.produced_count, 1,
      `expected produced_count=1 (only OUR session's fact), got ${out.produced_count}`);
  });
});

test('finalizeDrain produced_count excludes ad-hoc retains in the SAME session', async () => {
  // Behavior regression: previously produced_count counted any long-term row
  // created after drainCutoff scoped to this session. An ad-hoc
  // /mindwright:retain / /mindwright:update_memory / explicit retainFact-
  // without-drainId call between drainBatch and finalizeDrain would inflate
  // produced_count. Fix: stamp drain-attributed long-term rows with
  // source_ref = `drain:<drainId>` and count by that exact tag.
  await withStore(async (store) => {
    for (let i = 0; i < 4; i++) {
      store.insertEntry({
        tier: 'short', kind: 'thinking', content: `s${i}`, sessionId: 'sess',
      });
    }
    const drain = drainBatch({ store, sessionId: 'sess' });

    // The "this drain" fact: stamped with drainId.
    await retainFact({
      store, drainId: drain.drain_id, content: 'distilled by THIS drain',
      category: 'fact', scope: 'project', embed: stubEmbed, sessionId: 'sess',
    });

    // An ad-hoc retain in the SAME session — no drainId. Simulates an
    // explicit /mindwright:retain or /mindwright:update_memory call between
    // drainBatch and finalizeDrain.
    await retainFact({
      store, content: 'ad-hoc retain unrelated to drain',
      category: 'fact', scope: 'project', embed: stubEmbed, sessionId: 'sess',
    });

    const out = finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId: 'sess',
    });
    assert.equal(out.produced_count, 1,
      `expected produced_count=1 (only the drain-stamped fact), got ${out.produced_count}`);
  });
});

test('finalizeDrain leaves rows added AFTER drainBatch alone (cutoff respected)', async () => {
  await withStore(async (store) => {
    const oldId = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'old', sessionId: 'sess',
    });

    const drain = drainBatch({ store, sessionId: 'sess' });

    // Add a fresh row AFTER drainBatch. Same-ms timestamps are fine — the
    // store's (created_at, id) compound order makes freshId > drain_cutoff_id
    // strictly, so finalizeDrain's tuple comparison spares this row.
    const freshId = store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'fresh', sessionId: 'sess',
    });

    finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId: 'sess',
    });
    assert.equal(store.fetch(oldId), undefined); // drained
    assert.ok(store.fetch(freshId)); // survived
  });
});

test('finalizeDrain partitions rows that share the cutoff millisecond by id', async () => {
  // Regression: a PreToolUse burst writes cli_prompt + thinking + text in a
  // single db.transaction, so all three rows commit with identical ms-resolution
  // ISO timestamps. A plain `created_at <= cutoff` predicate would over-delete:
  // if the drain boundary lands inside such a group, rows the dream cycle never
  // saw get hard-deleted. The (created_at, id) row-value comparison fixes that.
  await withStore((store) => {
    const sessionId = 'race';
    const tx = store.db.transaction(() => {
      for (let i = 0; i < 6; i++) {
        store.insertEntry({
          tier: 'short', kind: 'thinking', content: `burst-${i}`, sessionId,
        });
      }
    });
    tx();
    // All 6 rows share the same created_at. drainPct=0.5 → drains 3 of 6.
    const drain = drainBatch({ store, sessionId, drainPct: 0.5 });
    assert.equal(drain.drained_count, 3);
    // Pick the three smallest ids — those are what drainBatch saw.
    const allRows = store.db.prepare(
      `SELECT id FROM entries WHERE tier='short' AND active=1 AND session_id=? ORDER BY id ASC`
    ).all(sessionId);
    const drainedIds = allRows.slice(0, 3).map((r) => r.id);
    const survivorIds = allRows.slice(3).map((r) => r.id);

    finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId,
    });

    for (const id of drainedIds) {
      assert.equal(store.fetch(id), undefined, `expected drained id ${id} to be gone`);
    }
    for (const id of survivorIds) {
      assert.ok(store.fetch(id), `expected survivor id ${id} to remain — same-ms over-delete regression`);
    }
  });
});

test('drainBatch claims its slice so a concurrent drainBatch cannot re-grab the same rows', async () => {
  // Regression for behavior-6 / DESIGN.md "Mark them as consolidating so
  // concurrent writes don't include them in a parallel pass." Without
  // drain_locks, two sessions racing /mindwright:dream both pick the same
  // oldest 70% and double-write long-term facts.
  await withStore((store) => {
    const sessionId = 'race';
    for (let i = 0; i < 10; i++) {
      store.insertEntry({ tier: 'short', kind: 'thinking', content: `obs-${i}`, sessionId });
    }
    const first = drainBatch({ store, sessionId, drainPct: 0.7 });
    assert.equal(first.drained_count, 7);

    // The second dream starts before the first finalizes. It must NOT see
    // the seven rows the first one is mid-consolidation on. With only three
    // unclaimed rows left and drainPct=0.7, drainCount=max(1, floor(3*0.7))=2.
    const second = drainBatch({ store, sessionId, drainPct: 0.7 });
    assert.equal(second.drained_count, 2);
    const firstClaimedIds = new Set(first.exchanges.flatMap((e) => e.rows).map((r) => r.id));
    const secondClaimedIds = new Set(second.exchanges.flatMap((e) => e.rows).map((r) => r.id));
    for (const id of secondClaimedIds) {
      assert.ok(!firstClaimedIds.has(id), `id ${id} double-claimed across concurrent drains`);
    }

    // Once the first dream finalizes (hard-delete + CASCADE clears its
    // locks), the third drain sees only the still-pending second-drain
    // entries (locked) plus any survivors.
    finalizeDrain({
      store,
      drainId: first.drain_id,
      drainCutoff: first.drain_cutoff,
      drainCutoffId: first.drain_cutoff_id,
      sessionId,
    });
    const third = drainBatch({ store, sessionId, drainPct: 0.7 });
    // 10 - 7 finalized - 2 still locked under `second` = 1 unclaimed row; floor(1 * 0.7) = 0,
    // clamped to 1 by Math.max in drainBatch.
    assert.equal(third.drained_count, 1);
  });
});

test('finalizeDrain partitions by drain_id — does NOT over-delete a concurrent drain\'s locked rows', async () => {
  // Regression: finalizeDrain used to scope only by (created_at, id) <= cutoff
  // + optional sessionId. Two concurrent scope='all' (or same-session) drains
  // hold disjoint slices via drain_locks, but the drain with the HIGHER cutoff
  // would scoop up the LOWER-cutoff drain's claimed rows when it finalized
  // first — hard-deleting them AND cascade-destroying the peer's drain_lock
  // entries (FK ON DELETE CASCADE in 0001_init.sql:131). The fix partitions
  // the SELECT/DELETE by drain_id from drain_locks; the cutoff stays as a
  // defense-in-depth guard.
  await withStore((store) => {
    const sessionId = 'race';
    for (let i = 0; i < 10; i++) {
      store.insertEntry({ tier: 'short', kind: 'thinking', content: `row-${i}`, sessionId });
    }
    // first claims oldest 7 (rows 0-6); second sees only rows 7-9 and claims
    // 70% of those = 2 (rows 7-8). second.drain_cutoff_id > first.drain_cutoff_id.
    const first = drainBatch({ store, sessionId, drainPct: 0.7 });
    const second = drainBatch({ store, sessionId, drainPct: 0.7 });
    assert.equal(first.drained_count, 7);
    assert.equal(second.drained_count, 2);
    const firstIds = new Set(first.exchanges.flatMap((e) => e.rows).map((r) => r.id));
    const secondIds = new Set(second.exchanges.flatMap((e) => e.rows).map((r) => r.id));

    // Finalize SECOND first — the cutoff-only predicate would over-delete
    // first's rows here (they all satisfy (created_at, id) <= second.cutoff).
    const out = finalizeDrain({
      store,
      drainId: second.drain_id,
      drainCutoff: second.drain_cutoff,
      drainCutoffId: second.drain_cutoff_id,
      sessionId,
    });
    assert.equal(out.drained_count, 2, 'finalize must touch only second drain\'s 2 rows, not 9');

    // first's rows survive
    for (const id of firstIds) {
      assert.ok(store.fetch(id), `first-drain row ${id} must survive — over-delete regression`);
    }
    // second's rows are gone
    for (const id of secondIds) {
      assert.equal(store.fetch(id), undefined, `second-drain row ${id} must be deleted`);
    }
    // first's drain_locks survive the cascade — finalize second must NOT
    // wipe first's claim
    const remainingLocks = store.db.prepare(
      'SELECT entry_id FROM drain_locks WHERE drain_id = ?'
    ).all(first.drain_id);
    assert.equal(remainingLocks.length, 7, 'first drain\'s 7 locks must remain after second finalizes');
  });
});

test('finalizeDrain rejects null/empty drainId (partition key required)', async () => {
  // The partition-by-drain_id fix makes drainId load-bearing. A falsy drainId
  // would silently no-op (the IN-subselect returns empty); we instead throw to
  // catch caller bugs immediately.
  await withStore((store) => {
    store.insertEntry({ tier: 'short', kind: 'thinking', content: 'r1', sessionId: 's' });
    const drain = drainBatch({ store, sessionId: 's' });
    assert.throws(
      () => finalizeDrain({
        store,
        drainId: null,
        drainCutoff: drain.drain_cutoff,
        drainCutoffId: drain.drain_cutoff_id,
        sessionId: 's',
      }),
      /non-empty drainId/,
    );
    assert.throws(
      () => finalizeDrain({
        store,
        drainId: '',
        drainCutoff: drain.drain_cutoff,
        drainCutoffId: drain.drain_cutoff_id,
        sessionId: 's',
      }),
      /non-empty drainId/,
    );
  });
});

// ----- event_ts provenance: drain/retain propagation, cursor UNCHANGED -----

test('DRAIN-CURSOR INVARIANT: event_ts never leaks into drain ordering or the finalize cursor', async () => {
  // The single most important correctness rule of the seeding overhaul:
  // event_ts governs RELEVANCE ranking ONLY. The drain selection
  // (ORDER BY created_at ASC, id ASC) and finalizeDrain's
  // (created_at, id) <= (cutoff, cutoff_id) predicate MUST stay on
  // created_at. A seeded batch has uniform created_at (seed-run time) and
  // wildly NON-monotonic event_ts (true historical times). If event_ts
  // ever leaked into the cursor, the drained/deleted set would be selected
  // by event_ts and diverge from the (created_at,id) prefix — silently
  // draining the wrong rows and hard-deleting content the dream never saw.
  await withStore((store) => {
    const sessionId = 'cursor-inv';
    // Insert 10 rows in ONE transaction → uniform created_at (the proven
    // same-ms-burst pattern used by the cutoff-partition test above).
    // event_ts is set INVERSELY to id: the lowest id gets the NEWEST
    // event_ts, the highest id the OLDEST. If event_ts leaked into the
    // ASC cursor, the drained prefix would be the HIGH ids, not the low.
    const ids = [];
    const tx = store.db.transaction(() => {
      for (let i = 0; i < 10; i++) {
        const id = store.insertEntry({
          tier: 'short', kind: 'thinking',
          content: `cursor-row-${i}`, sessionId,
          // Year descends as i ascends: id↑ ⇒ event_ts older.
          eventTs: `${2099 - i}-01-01T00:00:00.000Z`,
        });
        ids.push(id);
      }
    });
    tx();
    ids.sort((a, b) => Number(a) - Number(b));

    const drain = drainBatch({ store, sessionId, drainPct: 0.5 });
    assert.equal(drain.drained_count, 5);
    const drainedIds = drain.exchanges
      .flatMap((e) => e.rows)
      .map((r) => Number(r.id))
      .sort((a, b) => a - b);
    // Must be the FIVE LOWEST ids — proves ordering is (created_at,id) ASC,
    // NOT event_ts (which would have selected the five highest ids).
    assert.deepEqual(drainedIds, ids.slice(0, 5).map(Number),
      'drain must select the lowest-id prefix; event_ts must NOT reorder it');

    finalizeDrain({
      store,
      drainId: drain.drain_id,
      drainCutoff: drain.drain_cutoff,
      drainCutoffId: drain.drain_cutoff_id,
      sessionId,
    });
    // Exactly the drained ids are gone; the rest survive — event_ts (which
    // would have inverted this) did not enter the finalize cursor.
    for (const id of ids.slice(0, 5)) {
      assert.equal(store.fetch(id), undefined, `drained id ${id} must be deleted`);
    }
    for (const id of ids.slice(5)) {
      assert.ok(store.fetch(id), `survivor id ${id} must remain — event_ts leaked into finalize cursor`);
    }
  });
});

test('drainBatch surfaces each row event_ts and a per-exchange representative (max)', async () => {
  await withStore((store) => {
    const sessionId = 'evt-drain';
    // One exchange: cli_prompt opener + two attached rows. Mixed event_ts,
    // deliberately NOT in chronological order, plus one NULL.
    store.insertEntry({
      tier: 'short', kind: 'cli_prompt', content: 'the prompt',
      sessionId, eventTs: '2024-03-01T00:00:00.000Z',
    });
    store.insertEntry({
      tier: 'short', kind: 'thinking', content: 'pondering',
      sessionId, eventTs: '2025-11-15T12:00:00.000Z', // the max
    });
    store.insertEntry({
      tier: 'short', kind: 'text', content: 'answer',
      sessionId, // no eventTs → NULL
    });

    const drain = drainBatch({ store, sessionId, drainPct: 1 });
    const rows = drain.exchanges.flatMap((e) => e.rows);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].event_ts, '2024-03-01T00:00:00.000Z');
    assert.equal(rows[1].event_ts, '2025-11-15T12:00:00.000Z');
    assert.equal(rows[2].event_ts, null, 'row with no source event_ts → NULL');

    // The representative the dream skill forwards to retain_fact: the MAX
    // non-null event_ts of the exchange's rows (NULLs ignored).
    assert.equal(drain.exchanges.length, 1);
    assert.equal(drain.exchanges[0].event_ts, '2025-11-15T12:00:00.000Z',
      'exchange.event_ts must be the max of its rows, ignoring NULLs');
  });
});

test('groupIntoExchanges representative event_ts is the max, NULL when no row has one', () => {
  // Pure-function guard: the representative is a deterministic max computed
  // in code (the LLM forwards it opaquely, like drain_id — it must never do
  // timestamp arithmetic itself).
  const mixed = groupIntoExchanges([
    { id: 1, kind: 'cli_prompt', content: 'a', created_at: '1', event_ts: '2020-01-01T00:00:00.000Z' },
    { id: 2, kind: 'thinking', content: 'b', created_at: '2', event_ts: '2026-09-09T09:09:09.000Z' },
    { id: 3, kind: 'text', content: 'c', created_at: '3', event_ts: null },
  ]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].event_ts, '2026-09-09T09:09:09.000Z');

  const allNull = groupIntoExchanges([
    { id: 1, kind: 'cli_prompt', content: 'a', created_at: '1', event_ts: null },
    { id: 2, kind: 'thinking', content: 'b', created_at: '2' }, // event_ts absent
  ]);
  assert.equal(allNull.length, 1);
  assert.equal(allNull[0].event_ts, null,
    'no row carries event_ts → exchange representative is NULL');
  // Per-row passthrough is still present for the absent case (null, not undefined).
  assert.equal(allNull[0].rows[0].event_ts, null);
  assert.equal(allNull[0].rows[1].event_ts, null);
});

test('retainFact stamps a representative eventTs on the long-term row; omitted → NULL', async () => {
  await withStore(async (store) => {
    const eventTime = '2025-07-04T16:20:00.000Z';
    const withTs = await retainFact({
      store,
      content: 'a distilled historical fact',
      category: 'episodic', scope: 'project',
      embed: stubEmbed,
      eventTs: eventTime,
    });
    const row = store.fetch(withTs.fact_id);
    assert.equal(row.tier, 'long');
    assert.equal(row.event_ts, eventTime,
      'long-term row distilled from a timestamped exchange must carry that event time');
    assert.ok(row.created_at && row.created_at !== row.event_ts,
      'created_at is the distill/write time, distinct from the (older) source event time');

    // Live/ad-hoc retain with no source event time → NULL (behaves exactly
    // as pre-change via COALESCE in retrieval).
    const noTs = await retainFact({
      store,
      content: 'a fact with no provenance time',
      category: 'fact', scope: 'project',
      embed: stubEmbed,
    });
    assert.equal(store.fetch(noTs.fact_id).event_ts, null);
  });
});

test('drainBatch reclaims rows from drain locks older than STALE_LOCK_HOURS', async () => {
  // Abandoned drain (process died, user walked away) must not stick its
  // rows out-of-band forever — stale locks self-recover at the next pass.
  await withStore((store) => {
    const sessionId = 'stale';
    for (let i = 0; i < 5; i++) {
      store.insertEntry({ tier: 'short', kind: 'thinking', content: `obs-${i}`, sessionId });
    }
    const first = drainBatch({ store, sessionId, drainPct: 0.7 });
    assert.equal(first.drained_count, 3);
    // Manually backdate the locks 24h so the stale-cutoff filter expires them.
    const ancient = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    store.db.prepare('UPDATE drain_locks SET acquired_at = ?').run(ancient);

    // A new drain sees all 5 again — the stale ones were silently released.
    const second = drainBatch({ store, sessionId, drainPct: 0.7 });
    assert.equal(second.drained_count, 3, 'stale-claimed rows must be re-eligible after STALE_LOCK_HOURS');
  });
});
