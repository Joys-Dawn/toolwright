#!/usr/bin/env node
'use strict';

// CLI entry point for the /undo slash command. Two modes:
//
//   node undo.js --diff   → print JSON summary of what /undo would do
//   node undo.js --apply  → actually restore the snapshot to the working tree
//
// The slash command (commands/undo.md) must invoke these via the Bash tool,
// NOT via `!` preprocessing — otherwise --apply runs before the user can
// confirm. See the audit finding in the source history for details.

const { computeDiff, restoreSnapshot } = require('../lib/restore');
const { resolveRepoRoot } = require('../lib/root');

function die(msg, code = 1) {
  process.stderr.write(`timewright: ${msg}\n`);
  process.exit(code);
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function cmdDiff(cwd) {
  let diff;
  try {
    diff = computeDiff(cwd);
  } catch (err) {
    printJson({ ok: false, error: err.message });
    process.exit(2);
  }

  const summary = {
    ok: true,
    hasChanges:
      diff.modified.length > 0 ||
      diff.added.length > 0 ||
      diff.removed.length > 0,
    counts: {
      modified: diff.modified.length,
      added: diff.added.length,
      removed: diff.removed.length
    },
    // Modified: file exists in both, contents differ.
    // These will be REVERTED to the snapshot version.
    modified: diff.modified,
    // Added: file exists in working tree but not in snapshot.
    // These will be DELETED from the working tree. (Dangerous set.)
    added: diff.added,
    // Removed: file exists in snapshot but not in working tree.
    // These will be RESTORED to the working tree.
    removed: diff.removed,
    headDrift: diff.headDrift,
    snapshotCreatedAt: diff.metadata ? diff.metadata.createdAt : null
  };
  printJson(summary);
}

function cmdApply(cwd) {
  let result;
  try {
    result = restoreSnapshot(cwd);
  } catch (err) {
    printJson({ ok: false, error: err.message });
    process.exit(2);
  }

  const payload = { ok: true, applied: true };
  if (result && Array.isArray(result.errors) && result.errors.length > 0) {
    payload.errors = result.errors;
    payload.partial = true;
  }
  printJson(payload);
}

function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // Resolve the project root via the same walk-up + git-toplevel pattern the
  // hooks use. If Claude `cd`'d into a subdirectory before invoking /undo,
  // this still lands on the repo root where the snapshot lives.
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    die('not inside a git repository');
  }

  const mode = args[0];
  if (mode === '--diff') {
    cmdDiff(repoRoot);
  } else if (mode === '--apply') {
    cmdApply(repoRoot);
  } else {
    die('usage: undo.js --diff | --apply');
  }
}

main();
