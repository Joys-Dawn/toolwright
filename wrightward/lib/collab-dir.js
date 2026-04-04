'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_FILE = 'root';

/**
 * Ensures .claude/collab/ directory and subdirectories exist at `projectRoot`.
 * Writes a `root` file recording the project root so later hooks can find it
 * even if `cwd` has shifted (e.g. after an agent cd's into a subdirectory).
 * Adds .claude/collab/ to .gitignore if not already present.
 * Returns the absolute path to .claude/collab/.
 */
function ensureCollabDir(projectRoot) {
  const resolved = path.resolve(projectRoot);
  const collabDir = path.join(resolved, '.claude', 'collab');
  const contextDir = path.join(collabDir, 'context');
  const contextHashDir = path.join(collabDir, 'context-hash');

  fs.mkdirSync(collabDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(contextHashDir, { recursive: true });

  // Record the project root so resolveCollabDir can find it later.
  fs.writeFileSync(path.join(collabDir, ROOT_FILE), resolved, 'utf8');

  // Ensure .claude/collab/ is in .gitignore
  const gitignorePath = path.join(resolved, '.gitignore');
  let gitignoreContent = '';
  try {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  } catch (e) {
    // .gitignore doesn't exist yet
  }

  const lines = gitignoreContent.split('\n').map(l => l.trim());
  const alreadyIgnored = lines.some(l => l === '.claude/collab/' || l === '.claude/collab' || l === '.claude/' || l === '.claude');
  if (!alreadyIgnored) {
    const newline = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, gitignoreContent + newline + '.claude/collab/\n', 'utf8');
  }

  return collabDir;
}

/**
 * Reads the root file from a collab dir and returns { root, collabDir },
 * or null if the root file is missing/corrupt.
 * When `heal` is true and the root file is missing but the collab dir exists,
 * regenerate the root file (the project root is two levels up from collabDir).
 */
function readRootFile(collabDir, heal) {
  const rootFilePath = path.join(collabDir, ROOT_FILE);
  let content;
  try {
    content = fs.readFileSync(rootFilePath, 'utf8').trim();
  } catch (_) {
    content = '';
  }

  if (content && fs.existsSync(path.join(content, '.claude', 'collab'))) {
    return { root: content, collabDir: path.join(content, '.claude', 'collab') };
  }

  if (!heal || !fs.existsSync(collabDir)) return null;

  // Root file missing/corrupt but collab dir exists — regenerate it.
  // collabDir is <projectRoot>/.claude/collab, so two levels up is the root.
  try {
    const projectRoot = path.resolve(collabDir, '..', '..');
    fs.writeFileSync(rootFilePath, projectRoot, 'utf8');
    return { root: projectRoot, collabDir };
  } catch (_) {
    return null;
  }
}

/**
 * Resolves the collab directory from the project root recorded at session start.
 * Walks up from `cwd` looking for an existing .claude/collab/root file.
 * Returns { root, collabDir } or null if .claude/collab doesn't exist anywhere.
 */
function resolveCollabDir(cwd) {
  let dir = path.resolve(cwd);
  const { root: fsRoot } = path.parse(dir);

  // Check cwd itself first (common case — cwd hasn't shifted)
  const directResult = readRootFile(path.join(dir, '.claude', 'collab'), true);
  if (directResult) return directResult;

  // Walk up to find the root file (cwd has shifted into a subdirectory)
  dir = path.dirname(dir);
  while (dir !== fsRoot) {
    const result = readRootFile(path.join(dir, '.claude', 'collab'), true);
    if (result) return result;
    dir = path.dirname(dir);
  }

  return null;
}

module.exports = { ensureCollabDir, resolveCollabDir };
