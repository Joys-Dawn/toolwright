import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { openDb, insertIdea, updateNovelty, updateFeasibility } from '../../lib/db.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/ideawright.mjs', import.meta.url));

// Run the real CLI as a subprocess. `hook` selects a Node module-customization
// loader (installed via --import) that lets us drive two otherwise-unreachable
// branches against the REAL script without mutating the repo:
//   'missing-miners' → make `import('../lib/miners/runner.mjs')` reject with
//                       ERR_MODULE_NOT_FOUND (exercises safeImport's exit(2)).
//   'stub-vet'       → substitute a runNoveltyPass stub that prints the merged
//                       run options (exercises runVet's config deep-merge).
function runCli(args, { repoRoot, config, hook } = {}) {
  const dir = repoRoot ?? mkdtempSync(join(tmpdir(), 'ideawright-cli-'));
  if (config !== undefined) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'ideawright.json'),
      typeof config === 'string' ? config : JSON.stringify(config));
  }
  const env = { ...process.env, IDEAWRIGHT_REPO_ROOT: dir };
  const nodeArgs = [];
  let hookDir;
  if (hook) {
    hookDir = mkdtempSync(join(tmpdir(), 'ideawright-hook-'));
    writeFileSync(join(hookDir, 'register.mjs'),
      `import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n`);
    writeFileSync(join(hookDir, 'hooks.mjs'), HOOKS_SRC);
    nodeArgs.push('--import', pathToFileURL(join(hookDir, 'register.mjs')).href);
    env.IDEAWRIGHT_TEST_HOOK = hook;
  }
  nodeArgs.push(SCRIPT, ...args);
  const r = spawnSync(process.execPath, nodeArgs, { env, encoding: 'utf8' });
  if (hookDir) rmSync(hookDir, { recursive: true, force: true });
  if (!repoRoot) rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const HOOKS_SRC = `
export async function resolve(specifier, context, nextResolve) {
  if (process.env.IDEAWRIGHT_TEST_HOOK === 'missing-miners'
      && specifier.replace(/\\\\/g, '/').endsWith('lib/miners/runner.mjs')) {
    const err = new Error('mocked missing: ' + specifier);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (process.env.IDEAWRIGHT_TEST_HOOK === 'stub-vet'
      && url.replace(/\\\\/g, '/').endsWith('lib/novelty/runner.mjs')) {
    const src = "export async function runNoveltyPass(opts){"
      + "console.log('VETOPTS '+JSON.stringify({"
      + "maxPerRun: opts.maxPerRun===Infinity?'Infinity':opts.maxPerRun,"
      + "concurrency: opts.concurrency,"
      + "thresholds: opts.thresholds,"
      + "model: opts.model ?? null,"
      + "sources: opts.sources}));"
      + "return undefined;}";
    return { format: 'module', source: src, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

function vetOpts(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('VETOPTS '));
  assert.ok(line, `expected a VETOPTS line, got: ${JSON.stringify(stdout)}`);
  return JSON.parse(line.slice('VETOPTS '.length));
}

// -- dispatch ----------------------------------------------------------------

test('unknown command prints usage to stderr and exits 1', () => {
  const r = runCli(['bogus-command']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: ideawright <status\|scan\|vet\|daily\|config-init>/);
});

test('no command prints usage and exits 1', () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: ideawright/);
});

// -- status ------------------------------------------------------------------

test('status emits counts and top_promoted JSON projected from the DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideawright-cli-'));
  try {
    const db = openDb({ repoRoot: dir });
    insertIdea(db, { title: 'A New One', target_user: 'devs' }); // stays 'new'
    const { id } = insertIdea(db, { title: 'Promoted One', target_user: 'teams' });
    updateNovelty(db, id, { score_0_100: 90, verdict: 'novel', competitors: [] }, 'verified');
    updateFeasibility(db, id,
      { code_only: true, no_capital: true, no_private_data: true, impl_sketch: 's', effort: 'days', score_0_100: 80, verdict: 'go' },
      0.77, 'promoted');
    db.close();

    const r = runCli(['status'], { repoRoot: dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);

    assert.equal(out.counts.new, 1);
    assert.equal(out.counts.promoted, 1);
    assert.equal(out.top_promoted.length, 1);
    assert.deepEqual(Object.keys(out.top_promoted[0]).sort(), [
      'composite_rank', 'feasibility_verdict', 'id', 'novelty_verdict', 'target_user', 'title',
    ]);
    assert.equal(out.top_promoted[0].title, 'Promoted One');
    assert.equal(out.top_promoted[0].composite_rank, 0.77);
    assert.equal(out.top_promoted[0].novelty_verdict, 'novel');
    assert.equal(out.top_promoted[0].feasibility_verdict, 'go');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- safeImport --------------------------------------------------------------

test('safeImport exits 2 with a "module not yet built" message when a stage module is missing', () => {
  const r = runCli(['scan'], { hook: 'missing-miners' });
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /ideawright: miners module not yet built/);
});

// -- runVet config deep-merge ------------------------------------------------

test('runVet with no config uses DEFAULTS (thresholds, novelty model, concurrency, unlimited maxPerRun, all sources)', () => {
  const r = runCli(['vet'], { hook: 'stub-vet' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const o = vetOpts(r.stdout);

  assert.deepEqual(o.thresholds, { novelMax: 2, nicheMax: 5, competitorOverlap: 0.6 });
  assert.equal(o.model, 'claude-haiku-4-5-20251001', 'default novelty model');
  assert.equal(o.concurrency, 8);
  assert.equal(o.maxPerRun, 'Infinity', 'null max_per_run → Infinity (vet every new idea)');
  assert.equal(o.sources.exa.enabled, true);
  assert.equal(o.sources.scholar.enabled, true);
});

test('runVet deep-merges config.novelty over DEFAULTS (thresholds, concurrency, model, per-source enabled)', () => {
  const r = runCli(['vet'], {
    hook: 'stub-vet',
    config: { novelty: { novel_max: 9, concurrency: 3, llm: { model: 'cfg-model' }, sources: { hn: { enabled: false } } } },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const o = vetOpts(r.stdout);

  assert.equal(o.thresholds.novelMax, 9, 'config threshold overrides default');
  assert.equal(o.thresholds.nicheMax, 5, 'untouched threshold keeps default');
  assert.equal(o.concurrency, 3);
  assert.equal(o.model, 'cfg-model');
  assert.equal(o.sources.hn.enabled, false, 'per-source override applied');
  assert.equal(o.sources.github.enabled, true, 'other sources keep DEFAULTS via shallow source merge');
});

test('runVet model precedence: a global config.llm.model is shadowed by the novelty-default model', () => {
  // Pins the actual precedence: n = {...DEFAULTS.novelty, ...config.novelty},
  // so n.llm defaults to DEFAULTS.novelty.llm. `n.llm?.model ?? config.llm?.model`
  // therefore resolves to the novelty default UNLESS config.novelty.llm is set.
  const shadowed = vetOpts(runCli(['vet'], {
    hook: 'stub-vet', config: { llm: { model: 'global-model' } },
  }).stdout);
  assert.equal(shadowed.model, 'claude-haiku-4-5-20251001',
    'global llm.model does NOT win over the novelty default');

  const novOverride = vetOpts(runCli(['vet'], {
    hook: 'stub-vet', config: { novelty: { llm: { model: 'nov-model' } }, llm: { model: 'global-model' } },
  }).stdout);
  assert.equal(novOverride.model, 'nov-model', 'config.novelty.llm.model takes precedence');
});
