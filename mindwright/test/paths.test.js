// Tests for lib/paths.js: the embedder-cache probe and the cwd→transcript-dir
// slug encoding (and its composition into transcriptsDir / nativeMemoryDir).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  embedderCached,
  projectSlug,
  claudeProjectsDir,
  transcriptsDir,
  nativeMemoryDir,
  pluginDataArg,
  pluginDataDir,
  PLUGIN_ROOT,
} from '../lib/paths.js';

test('embedderCached returns true under MINDWRIGHT_USE_STUB_MODELS=1', () => {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevCacheDir = process.env.MINDWRIGHT_MODEL_CACHE_DIR;
  const cacheDir = mkdtempSync(join(tmpdir(), 'mw-paths-stub-'));
  process.env.MINDWRIGHT_MODEL_CACHE_DIR = cacheDir;
  process.env.MINDWRIGHT_USE_STUB_MODELS = '1';
  try {
    // Empty cache dir; stub mode must still short-circuit to true.
    assert.equal(embedderCached(), true);
  } finally {
    if (prevStub === undefined) delete process.env.MINDWRIGHT_USE_STUB_MODELS;
    else process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevCacheDir === undefined) delete process.env.MINDWRIGHT_MODEL_CACHE_DIR;
    else process.env.MINDWRIGHT_MODEL_CACHE_DIR = prevCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('embedderCached returns false when the bge-m3 dir is absent and stubs disabled', () => {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevCacheDir = process.env.MINDWRIGHT_MODEL_CACHE_DIR;
  const cacheDir = mkdtempSync(join(tmpdir(), 'mw-paths-nocache-'));
  process.env.MINDWRIGHT_MODEL_CACHE_DIR = cacheDir;
  delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  try {
    assert.equal(embedderCached(), false);
  } finally {
    if (prevStub !== undefined) process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevCacheDir === undefined) delete process.env.MINDWRIGHT_MODEL_CACHE_DIR;
    else process.env.MINDWRIGHT_MODEL_CACHE_DIR = prevCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('embedderCached returns true when the bge-m3 dir is present (planted) and stubs disabled', () => {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevCacheDir = process.env.MINDWRIGHT_MODEL_CACHE_DIR;
  const cacheDir = mkdtempSync(join(tmpdir(), 'mw-paths-cached-'));
  // transformers.js <org>/<name> layout — NOT the Python-hub models--org--name.
  mkdirSync(join(cacheDir, 'Xenova', 'bge-m3'), { recursive: true });
  process.env.MINDWRIGHT_MODEL_CACHE_DIR = cacheDir;
  delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  try {
    assert.equal(embedderCached(), true);
  } finally {
    if (prevStub !== undefined) process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevCacheDir === undefined) delete process.env.MINDWRIGHT_MODEL_CACHE_DIR;
    else process.env.MINDWRIGHT_MODEL_CACHE_DIR = prevCacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// projectSlug / claudeProjectsDir / transcriptsDir / nativeMemoryDir: the
// cwd→transcript-dir encoding and its composition. This is load-bearing — it
// is the single source of truth lib/native-memory.js and lib/seed-loop.js
// rely on to land on the SAME directory a real Claude Code hook produced. A
// silent drift here means the transcript-bootstrap loop scans an empty/wrong
// directory and the "learn from your project's history" feature is a no-op.

test('projectSlug encodes a Windows project root exactly as Claude Code does (documented live-tree invariant)', () => {
  // Pinned verbatim to the verified example in the lib/paths.js comment:
  // the drive colon AND the path separator each become a single '-', so
  // "C:\…" yields the leading "C--…".
  assert.equal(
    projectSlug(String.raw`C:\Users\yiann\Documents\AI_engineering`),
    'C--Users-yiann-Documents-AI-engineering',
  );
});

test('projectSlug replaces every non-alphanumeric character (incl. "_" and ".") and preserves case', () => {
  assert.equal(projectSlug('/home/alice/my project'), '-home-alice-my-project');
  assert.equal(projectSlug('/Users/bob/code.v2'), '-Users-bob-code-v2');
  assert.equal(projectSlug('/srv/AI_engineering'), '-srv-AI-engineering');
});

test('projectSlug with no argument derives the slug from MINDWRIGHT_PROJECT_ROOT (projectRoot default)', () => {
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = '/proj/Alpha.Beta';
  try {
    assert.equal(projectSlug(), '-proj-Alpha-Beta');
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
  }
});

test('claudeProjectsDir returns the MINDWRIGHT_CLAUDE_PROJECTS_DIR seam verbatim when set', () => {
  const prev = process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
  process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = '/fixture/projects';
  try {
    assert.equal(claudeProjectsDir(), '/fixture/projects');
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
    else process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = prev;
  }
});

test('claudeProjectsDir falls back to <home>/.claude/projects when the seam is unset', () => {
  const prevCpd = process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const fakeHome = mkdtempSync(join(tmpdir(), 'mw-paths-cpd-home-'));
  delete process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome; // os.homedir() reads USERPROFILE on win32
  try {
    assert.equal(claudeProjectsDir(), join(fakeHome, '.claude', 'projects'));
  } finally {
    if (prevCpd === undefined) delete process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
    else process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = prevCpd;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('transcriptsDir composes the seam dir with the encoded slug; nativeMemoryDir nests memory/ under it', () => {
  const prevCpd = process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const cpd = join(tmpdir(), 'mw-fixture-projects');
  process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = cpd;
  process.env.MINDWRIGHT_PROJECT_ROOT = '/proj/Alpha.Beta';
  try {
    const expectedBase = join(cpd, '-proj-Alpha-Beta');
    assert.equal(transcriptsDir(), expectedBase);
    assert.equal(nativeMemoryDir(), join(expectedBase, 'memory'));
  } finally {
    if (prevCpd === undefined) delete process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR;
    else process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR = prevCpd;
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
  }
});

// pluginDataArg / pluginDataDir: the Claude-Code-substituted persistent
// data dir, delivered via the `--plugin-data "${CLAUDE_PLUGIN_DATA}"` arg
// every hook/skill command is launched with. This is THE production
// resolution of node_modules + the model cache + the ABI marker; relying on
// the (not-universally-delivered) CLAUDE_PLUGIN_DATA env-export instead
// silently rooted the install at the EPHEMERAL PLUGIN_ROOT — the exact bug
// this contract closes. Every test that can mutate process.argv /
// process.env.CLAUDE_PLUGIN_DATA save+restores both (pluginDataDir() WRITES
// the env on adoption, and node --test shares one process within a file).

test('pluginDataArg reads the space form --plugin-data <dir>', () => {
  assert.equal(
    pluginDataArg(['node', 'x.js', '--plugin-data', '/data/here']),
    '/data/here',
  );
});

test('pluginDataArg reads the = form --plugin-data=<dir>', () => {
  assert.equal(
    pluginDataArg(['node', 'x.js', '--plugin-data=/data/eq']),
    '/data/eq',
  );
});

test('pluginDataArg returns null when the flag is absent', () => {
  assert.equal(pluginDataArg(['node', 'x.js', 'recall', '--session-id', 'abc']), null);
});

test('pluginDataArg rejects an un-substituted ${...} literal (both forms) — not running under Claude Code', () => {
  // Claude Code ALWAYS substitutes ${CLAUDE_PLUGIN_DATA} in a real run; a
  // literal reaching here means a dev/test/manual invocation, which must
  // fall back to PLUGIN_ROOT, never treat the literal as a path.
  assert.equal(
    pluginDataArg(['node', 'x.js', '--plugin-data', '${CLAUDE_PLUGIN_DATA}']),
    null,
  );
  assert.equal(
    pluginDataArg(['node', 'x.js', '--plugin-data=${CLAUDE_PLUGIN_DATA}']),
    null,
  );
});

test('pluginDataArg returns null for a dangling flag or an empty value', () => {
  assert.equal(pluginDataArg(['node', 'x.js', '--plugin-data']), null);
  assert.equal(pluginDataArg(['node', 'x.js', '--plugin-data', '']), null);
  assert.equal(pluginDataArg(['node', 'x.js', '--plugin-data=']), null);
});

test('pluginDataArg ignores argv[0..1] (node + script path), scanning from argv[2]', () => {
  // A script literally named --plugin-data must not be mistaken for the flag.
  assert.equal(pluginDataArg(['node', '--plugin-data', 'real-arg']), null);
});

test('pluginDataDir adopts the substituted arg into the env when CLAUDE_PLUGIN_DATA is unset', () => {
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  const prevArgv = process.argv;
  const target = mkdtempSync(join(tmpdir(), 'mw-cpd-arg-'));
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.argv = ['node', 'session-start.js', '--plugin-data', target];
  try {
    assert.equal(pluginDataDir(), target, 'arg value is returned');
    assert.equal(
      process.env.CLAUDE_PLUGIN_DATA,
      target,
      'adopted into the env so detached children (install-worker/daemon) inherit it via {...process.env}',
    );
    // Idempotent: a second call still resolves the same dir.
    assert.equal(pluginDataDir(), target);
  } finally {
    process.argv = prevArgv;
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
    rmSync(target, { recursive: true, force: true });
  }
});

test('pluginDataDir: an already-set CLAUDE_PLUGIN_DATA env wins over the arg (no clobber)', () => {
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  const prevArgv = process.argv;
  process.env.CLAUDE_PLUGIN_DATA = '/env/already/set';
  process.argv = ['node', 'session-start.js', '--plugin-data', '/arg/ignored'];
  try {
    assert.equal(pluginDataDir(), '/env/already/set');
  } finally {
    process.argv = prevArgv;
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
  }
});

test('pluginDataDir falls back to PLUGIN_ROOT when neither env nor arg is present (dev/test/manual)', () => {
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  const prevArgv = process.argv;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.argv = ['node', 'paths.test.js'];
  try {
    assert.equal(pluginDataDir(), PLUGIN_ROOT);
    assert.equal(
      process.env.CLAUDE_PLUGIN_DATA,
      undefined,
      'no arg ⇒ the env is left untouched (the dev-tree / test-suite contract auto-setup.js relies on)',
    );
  } finally {
    process.argv = prevArgv;
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
  }
});

test('pluginDataDir does NOT adopt an un-substituted ${...} literal — stays on PLUGIN_ROOT', () => {
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  const prevArgv = process.argv;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.argv = ['node', 'session-start.js', '--plugin-data', '${CLAUDE_PLUGIN_DATA}'];
  try {
    assert.equal(pluginDataDir(), PLUGIN_ROOT);
    assert.equal(process.env.CLAUDE_PLUGIN_DATA, undefined, 'the literal must never be adopted');
  } finally {
    process.argv = prevArgv;
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
  }
});
