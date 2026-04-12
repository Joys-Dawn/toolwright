'use strict';

// Shared helpers for timewright tests. Matches agentwright's convention of
// inlining most setup per test, but factors out the git-repo bootstrap
// because every snapshot-related test needs it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function makeTmpDir(label = 'tw-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function git(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
}

function isGitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

// Initialize a git repo with user.email/user.name configured. No commits.
// We explicitly force core.autocrlf=false so tests on Windows behave the same
// as on Linux/macOS — otherwise git's smudge filter would rewrite LF -> CRLF
// on the worktree-add path and create phantom diffs in tests that compare
// file contents literally.
function initGitRepo(cwd) {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@test.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  git(cwd, ['config', 'core.eol', 'lf']);
}

// Initialize a git repo AND make one initial commit containing the given
// file map. Returns { cwd, headSha }.
function initRepoWithCommit(fileMap = { 'init.txt': 'initial' }) {
  const cwd = makeTmpDir();
  initGitRepo(cwd);
  for (const [rel, content] of Object.entries(fileMap)) {
    writeFile(cwd, rel, content);
  }
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'initial']);
  // Force a re-checkout so the working tree has whatever line endings git's
  // smudge filters would produce on this platform. Without this step, test
  // files created via `writeFile` may have LF on disk while a subsequent
  // worktree-add snapshot has CRLF (on Windows with autocrlf=true), causing
  // phantom diffs that have nothing to do with the behavior being tested.
  const hasFiles = Object.keys(fileMap).length > 0;
  if (hasFiles) {
    for (const rel of Object.keys(fileMap)) {
      try { fs.unlinkSync(path.join(cwd, rel)); } catch {}
    }
    git(cwd, ['checkout', '-q', '.']);
  }
  const head = git(cwd, ['rev-parse', 'HEAD']);
  return { cwd, headSha: (head.stdout || '').trim() };
}

function writeFile(cwd, rel, content) {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function readFileIfExists(cwd, rel) {
  const abs = path.join(cwd, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

// Tears down a test directory AND any git worktree admin state that might
// still reference paths inside it. Call from afterEach to prevent state
// leaking between tests.
function cleanup(cwd) {
  if (!cwd) return;
  try {
    // Best-effort: if the repo still has a `.git`, prune any dangling
    // worktree entries before we blow the dir away.
    if (fs.existsSync(path.join(cwd, '.git'))) {
      git(cwd, ['worktree', 'prune', '--expire=now']);
    }
  } catch {}
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {}
}

// Resolves absolute paths to the timewright source modules under test so
// that `require(...)` works regardless of where the test file lives.
const TIMEWRIGHT_ROOT = path.resolve(__dirname, '..');

function srcPath(relFromRoot) {
  return path.join(TIMEWRIGHT_ROOT, relFromRoot);
}

function hookPath(name) {
  return path.join(TIMEWRIGHT_ROOT, 'hooks', name);
}

function binPath(name) {
  return path.join(TIMEWRIGHT_ROOT, 'bin', name);
}

module.exports = {
  makeTmpDir,
  git,
  isGitAvailable,
  initGitRepo,
  initRepoWithCommit,
  writeFile,
  readFileIfExists,
  cleanup,
  srcPath,
  hookPath,
  binPath,
  TIMEWRIGHT_ROOT
};
