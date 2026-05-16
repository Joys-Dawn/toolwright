// Defense-in-depth tests for lib/paths.js. session_id originates inside the
// Claude Code trust boundary, but pipePath() interpolates it into a real
// filesystem path on POSIX — reject traversal payloads before they ever
// reach `path.join`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pipePath,
  embedderCached,
  projectSlug,
  claudeProjectsDir,
  transcriptsDir,
  nativeMemoryDir,
} from '../lib/paths.js';

test('pipePath accepts a UUIDv4-shaped session_id', () => {
  const out = pipePath('16971ff3-0143-4488-9962-94d333bfffe8');
  assert.ok(typeof out === 'string' && out.length > 0);
});

test('pipePath accepts a short synthetic id like the tests use', () => {
  const out = pipePath('sess-A');
  assert.ok(typeof out === 'string' && out.length > 0);
});

test('pipePath rejects path-traversal payloads', () => {
  assert.throws(() => pipePath('../../../tmp/evil'), /not path-safe/i);
  assert.throws(() => pipePath('a/b'), /not path-safe/i);
  assert.throws(() => pipePath('a\\b'), /not path-safe/i);
  assert.throws(() => pipePath('a\0b'), /not path-safe/i);
});

test('pipePath rejects non-string input', () => {
  assert.throws(() => pipePath(null), /not path-safe/i);
  assert.throws(() => pipePath(undefined), /not path-safe/i);
  assert.throws(() => pipePath(42), /not path-safe/i);
});

test('pipePath rejects empty and overlong session_ids', () => {
  assert.throws(() => pipePath(''), /not path-safe/i);
  assert.throws(() => pipePath('x'.repeat(129)), /not path-safe/i);
});

test('embedderCached returns true under MINDWRIGHT_USE_STUB_MODELS=1', () => {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const fakeHome = mkdtempSync(join(tmpdir(), 'mw-paths-stub-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.MINDWRIGHT_USE_STUB_MODELS = '1';
  try {
    // No bge-m3 dir under the fake home; stub mode should still return true.
    assert.equal(embedderCached(), true);
  } finally {
    if (prevStub === undefined) delete process.env.MINDWRIGHT_USE_STUB_MODELS;
    else process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('embedderCached returns false when bge-m3 dir is absent and stubs disabled', () => {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const fakeHome = mkdtempSync(join(tmpdir(), 'mw-paths-nocache-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  try {
    assert.equal(embedderCached(), false);
  } finally {
    if (prevStub !== undefined) process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('embedderCached returns true when bge-m3 dir is present (planted) and stubs disabled', () => {
  const prevStub = process.env.MINDWRIGHT_USE_STUB_MODELS;
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const fakeHome = mkdtempSync(join(tmpdir(), 'mw-paths-cached-'));
  mkdirSync(join(fakeHome, '.cache', 'huggingface', 'hub', 'models--Xenova--bge-m3'),
    { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.MINDWRIGHT_USE_STUB_MODELS;
  try {
    assert.equal(embedderCached(), true);
  } finally {
    if (prevStub !== undefined) process.env.MINDWRIGHT_USE_STUB_MODELS = prevStub;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    rmSync(fakeHome, { recursive: true, force: true });
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
