import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

import { runOrchestration } from '../../lib/orchestration/runner.mjs';
import { openDb, insertIdea, updateNovelty, updateFeasibility } from '../../lib/db.mjs';

// runOrchestration writes a digest file under repoRoot and console.logs the
// summary + markdown. Give it a real temp repoRoot and silence the console.
function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'ideawright-orch-'));
  const db = openDb({ filename: join(dir, 'test.db') });
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// Swap console.log/error, capture lines, return a restore fn. runOrchestration
// is noisy by design; tests assert on return value + filesystem, not stdout.
function muteConsole() {
  const orig = { log: console.log, error: console.error };
  const logs = [];
  const errors = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  return { logs, errors, restore: () => Object.assign(console, orig) };
}

// Seed an idea straight to status='gated' (verified-novelty + feasibility set
// but composite_rank still NULL). gateFeasibility only touches status='verified'
// rows, so a 'gated' seed guarantees ZERO claude spawns while still giving
// rankAll + buildDigest real work — and proves the stage ordering.
function seedGatedIdea(db, { title, pain, noveltyScore = 80, feasScore = 70 }) {
  const { id } = insertIdea(db, {
    title, target_user: 'devs', summary: `${title} summary`, category: 'dev-tools',
    pain_evidence: [{ source_url: 'https://e.com/x', quote: 'I really need this', pain_score_0_10: pain }],
  });
  updateNovelty(db, id, { score_0_100: noveltyScore, verdict: 'novel', competitors: [] }, 'verified');
  updateFeasibility(db, id,
    { code_only: true, no_capital: true, no_private_data: true, impl_sketch: 's', effort: 'days', score_0_100: feasScore, verdict: 'go' },
    null, 'gated');
  return id;
}

test('runOrchestration on an empty DB returns the full summary shape and writes a placeholder digest', async () => {
  const env = freshEnv();
  const c = muteConsole();
  try {
    const summary = await runOrchestration({ db: env.db, repoRoot: env.dir });

    // Summary shape: feasibility + ranker + digest{promoted,count,path}.
    assert.deepEqual(Object.keys(summary).sort(), ['digest', 'feasibility', 'ranker']);
    assert.equal(summary.feasibility.total, 0, 'no verified ideas → feasibility is a no-op');
    assert.equal(summary.ranker.ranked, 0);
    assert.equal(summary.digest.count, 0);
    assert.equal(summary.digest.promoted, 0);
    // No config file → loadConfig returns {} → default weights applied.
    assert.deepEqual(summary.ranker.weights, { pain: 0.3, novelty: 0.4, feasibility: 0.3 });

    // Digest file is written at <repoRoot>/.claude/ideawright/digests/<today>.md.
    assert.ok(existsSync(summary.digest.path), 'digest file must be written');
    assert.match(readFileSync(summary.digest.path, 'utf8'), /No promoted ideas yet/);
  } finally {
    c.restore();
    cleanup(env);
  }
});

test('runOrchestration runs feasibility→rank→digest in order: gated ideas end up promoted with a composite_rank', async () => {
  const env = freshEnv();
  const c = muteConsole();
  try {
    seedGatedIdea(env.db, { title: 'Alpha Tool', pain: 9 });
    seedGatedIdea(env.db, { title: 'Beta Tool', pain: 6 });

    const summary = await runOrchestration({ db: env.db, repoRoot: env.dir });

    assert.equal(summary.feasibility.total, 0, 'no verified ideas → no claude spawn in feasibility');
    assert.equal(summary.ranker.ranked, 2, 'rankAll scored both gated ideas');
    assert.equal(summary.digest.count, 2);
    assert.equal(summary.digest.promoted, 2);

    // The end state is only reachable if rank ran BEFORE digest: digest's
    // selectTopN filters on `composite_rank IS NOT NULL`, so a 0-count digest
    // would result if rankAll had not already populated composite_rank.
    const promoted = env.db.prepare(
      `SELECT title, composite_rank FROM ideas WHERE status='promoted' ORDER BY composite_rank DESC`
    ).all();
    assert.equal(promoted.length, 2);
    assert.ok(promoted.every((r) => r.composite_rank != null), 'every promoted idea has a rank');
    assert.equal(promoted[0].title, 'Alpha Tool', 'higher-pain idea ranks first');

    const md = readFileSync(summary.digest.path, 'utf8');
    assert.match(md, /Alpha Tool/);
    assert.match(md, /Beta Tool/);
  } finally {
    c.restore();
    cleanup(env);
  }
});

test('runOrchestration falls back to defaults and logs when .claude/ideawright.json is malformed', async () => {
  const env = freshEnv();
  const c = muteConsole();
  try {
    mkdirSync(join(env.dir, '.claude'), { recursive: true });
    writeFileSync(join(env.dir, '.claude', 'ideawright.json'), '{ not: valid json,,, ');

    seedGatedIdea(env.db, { title: 'Survives Bad Config', pain: 7 });

    const summary = await runOrchestration({ db: env.db, repoRoot: env.dir });

    assert.ok(
      c.errors.some((e) => /\[runner\] failed to parse/.test(e) && /using defaults/.test(e)),
      `parse failure must be logged, saw: ${JSON.stringify(c.errors)}`,
    );
    // Graceful: the run still completes on default config.
    assert.deepEqual(summary.ranker.weights, { pain: 0.3, novelty: 0.4, feasibility: 0.3 });
    assert.equal(summary.digest.promoted, 1, 'pipeline still ran end-to-end on defaults');
    assert.ok(existsSync(summary.digest.path));
  } finally {
    c.restore();
    cleanup(env);
  }
});

test('runOrchestration honors digest.top_n and weights from a valid config', async () => {
  const env = freshEnv();
  const c = muteConsole();
  try {
    mkdirSync(join(env.dir, '.claude'), { recursive: true });
    writeFileSync(
      join(env.dir, '.claude', 'ideawright.json'),
      JSON.stringify({ digest: { top_n: 1 }, weights: { pain: 1, novelty: 0, feasibility: 0 } }),
    );

    seedGatedIdea(env.db, { title: 'Top By Pain', pain: 9 });
    seedGatedIdea(env.db, { title: 'Lower Pain', pain: 3 });

    const summary = await runOrchestration({ db: env.db, repoRoot: env.dir });

    assert.deepEqual(summary.ranker.weights, { pain: 1, novelty: 0, feasibility: 0 },
      'config weights are threaded into rankAll');
    assert.equal(summary.digest.count, 1, 'digest.top_n=1 caps the digest');
    assert.equal(summary.digest.promoted, 1);
    const md = readFileSync(summary.digest.path, 'utf8');
    assert.match(md, /Top By Pain/);
    assert.doesNotMatch(md, /Lower Pain/, 'only the single top-ranked idea is in the capped digest');
  } finally {
    c.restore();
    cleanup(env);
  }
});
