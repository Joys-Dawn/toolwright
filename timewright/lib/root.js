'use strict';

// Resolves the timewright project root for a given cwd.
//
// Timewright's snapshot mechanism is inherently repo-wide (`git worktree add
// HEAD` always checks out the entire repo), so "project root" is the git
// toplevel. But Claude Code's hook input `cwd` can be a subdirectory — the
// user may have launched Claude from one, or an agent may have `cd`'d into
// one mid-session. If we anchored state at that cwd, we'd either (a) dump a
// full-repo snapshot inside a subdir or (b) miss files with `../` prefixes.
//
// The resolution strategy mirrors wrightward's collab-dir pattern:
//   1. Walk up from cwd looking for an existing .claude/timewright/root file
//      — this handles mid-session cd shifts without re-running git.
//   2. Fall back to `git rev-parse --show-toplevel` from cwd — for first-run
//      sessions where no anchor exists yet.
//   3. If both fail, return null — caller should opt out (non-git project).
//
// When `establish: true`, a successful git-toplevel fallback is persisted to
// <repoRoot>/.claude/timewright/root so later hooks find it via walk-up.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_FILE = 'root';

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function getGitToplevel(cwd) {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return null;
  const top = (result.stdout || '').trim();
  if (!top) return null;
  return path.resolve(top);
}

function getTimewrightDir(repoRoot) {
  return path.join(repoRoot, '.claude', 'timewright');
}

function getRootFilePath(repoRoot) {
  return path.join(getTimewrightDir(repoRoot), ROOT_FILE);
}

function writeRootFile(repoRoot) {
  const dir = getTimewrightDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ROOT_FILE), repoRoot, 'utf8');
}

// Reads the root file from a timewright directory. Returns the absolute repo
// root path recorded there, or null if the file is missing or points at a
// dir that no longer has a timewright subtree.
function readRootFile(timewrightDir) {
  const rootFilePath = path.join(timewrightDir, ROOT_FILE);
  let content = '';
  try {
    content = fs.readFileSync(rootFilePath, 'utf8').trim();
  } catch {
    return null;
  }

  if (content && fs.existsSync(path.join(content, '.claude', 'timewright'))) {
    return content;
  }

  return null;
}

// Walks up from `cwd` looking for an existing .claude/timewright/root anchor.
// Returns the recorded repo root, or null if no anchor is found.
//
// This is deliberately read-only — it never creates directories or files.
// Walking past a parent directory that happens to have a `.claude/timewright/`
// (from an unrelated project, a previous test run, or the user's home) must
// not plant state there. The only writer is `resolveRepoRoot` with
// `establish: true`, and that only writes at the resolved git toplevel.
function walkUpForRoot(cwd) {
  let dir = path.resolve(cwd);
  const { root: fsRoot } = path.parse(dir);

  while (true) {
    const twDir = path.join(dir, '.claude', 'timewright');
    const root = readRootFile(twDir);
    if (root) return root;
    if (dir === fsRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolves the timewright repo root for a hook invocation.
// Returns null if the caller is not inside a git repo and no anchor is found
// — caller should opt out silently in that case.
//
// When `establish: true`, a successful git-toplevel fallback is persisted as
// the anchor. All three hooks set this, so after the first hook fires in a
// project the anchor is guaranteed to exist. Callers that don't set establish
// (e.g. `bin/undo.js`) still get the correct toplevel back — they just skip
// caching, which is fine because the next hook will write the anchor anyway.
function resolveRepoRoot(cwd, { establish = false } = {}) {
  const anchored = walkUpForRoot(cwd);
  if (anchored) return anchored;

  const toplevel = getGitToplevel(cwd);
  if (!toplevel) return null;

  if (establish) {
    try {
      writeRootFile(toplevel);
    } catch {
      // Best effort — if we can't persist the anchor, fall back to returning
      // the toplevel without caching. Next hook will re-derive it.
    }
  }

  return toplevel;
}

module.exports = {
  ROOT_FILE,
  getGitToplevel,
  getTimewrightDir,
  getRootFilePath,
  writeRootFile,
  readRootFile,
  walkUpForRoot,
  resolveRepoRoot
};
