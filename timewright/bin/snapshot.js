#!/usr/bin/env node
'use strict';

// CLI entry point for the /snapshot skill. Captures a fresh snapshot of the
// working tree on demand, overwriting any existing snapshot. Useful when the
// user can't rely on UserPromptSubmit firing (e.g. requests routed in from
// Discord via wrightward — those arrive between turns and don't trip the hook).

const { createSnapshot } = require('../lib/snapshot');
const { markFresh } = require('../lib/state');
const { resolveRepoRoot } = require('../lib/root');

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function main() {
  const cwd = process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    printJson({ ok: false, error: 'not inside a git repository' });
    process.exit(1);
  }

  let metadata;
  try {
    metadata = createSnapshot(repoRoot);
  } catch (err) {
    printJson({ ok: false, error: err.message });
    process.exit(2);
  }

  // Clear the stale markers so the next UserPromptSubmit doesn't immediately
  // overwrite this snapshot (unless a mutating tool fires in the meantime).
  markFresh(repoRoot);

  printJson({
    ok: true,
    createdAt: metadata.createdAt,
    realRepoHead: metadata.realRepoHead,
    unbornHead: metadata.unbornHead,
    dirtyFileCount: metadata.dirtyFileCount
  });
}

main();
