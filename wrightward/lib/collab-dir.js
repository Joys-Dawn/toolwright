'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Ensures .claude/collab/ directory and subdirectories exist at `cwd`.
 * Adds .claude/collab/ to .gitignore if not already present.
 * Returns the absolute path to .claude/collab/.
 */
function ensureCollabDir(cwd) {
  const collabDir = path.join(cwd, '.claude', 'collab');
  const contextDir = path.join(collabDir, 'context');
  const lastSeenDir = path.join(collabDir, 'last-seen');

  fs.mkdirSync(collabDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(lastSeenDir, { recursive: true });

  // Ensure .claude/collab/ is in .gitignore
  const gitignorePath = path.join(cwd, '.gitignore');
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

module.exports = { ensureCollabDir };
