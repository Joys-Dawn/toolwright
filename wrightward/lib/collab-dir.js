'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Ensures .collab/ directory and subdirectories exist at `cwd`.
 * Adds .collab/ to .gitignore if not already present.
 * Returns the absolute path to .collab/.
 */
function ensureCollabDir(cwd) {
  const collabDir = path.join(cwd, '.collab');
  const contextDir = path.join(collabDir, 'context');
  const lastSeenDir = path.join(collabDir, 'last-seen');

  fs.mkdirSync(collabDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(lastSeenDir, { recursive: true });

  // Ensure .collab/ is in .gitignore
  const gitignorePath = path.join(cwd, '.gitignore');
  let gitignoreContent = '';
  try {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  } catch (e) {
    // .gitignore doesn't exist yet
  }

  if (!gitignoreContent.split('\n').some(line => line.trim() === '.collab/' || line.trim() === '.collab')) {
    const newline = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, gitignoreContent + newline + '.collab/\n', 'utf8');
  }

  return collabDir;
}

module.exports = { ensureCollabDir };
