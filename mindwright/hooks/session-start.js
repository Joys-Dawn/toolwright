#!/usr/bin/env node
// SessionStart hook shim. Loads session-start-impl.js only after deps are
// present; while dormant, emits a one-line notice so the session explains
// itself instead of looking broken.
// HARD RULE: dep-free imports only (must not pull native deps into the
// dormant-path graph).

import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { runHookShim } from '../lib/hook-shim.js';
import { npmAvailable, installLogPath } from '../lib/auto-setup.js';
import { embedderCached } from '../lib/paths.js';

function sessionStartStdout(additionalContext) {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }) + '\n'
  );
}

// True when a prior background install produced output yet deps are still
// absent → the build is not succeeding. Must never throw: any fs error ⇒
// false ⇒ caller stays optimistic.
function installLogHasOutput() {
  try {
    return existsSync(installLogPath()) && statSync(installLogPath()).size > 0;
  } catch {
    return false;
  }
}

// Options object is a test seam: tests inject deterministic
// npm/model/install state without spawns or fs deps.
export function installingNotice({
  npmOk = npmAvailable,
  modelsCached = embedderCached,
  installFailing = installLogHasOutput,
} = {}) {
  // MINDWRIGHT_AUTO_INSTALL=false makes auto-install a deliberate no-op, so
  // claiming "an install is completing automatically" would be wrong.
  if (process.env.MINDWRIGHT_AUTO_INSTALL === 'false') {
    return sessionStartStdout(
      'mindwright native dependencies are not installed and auto-install is disabled '
        + '(MINDWRIGHT_AUTO_INSTALL=false) — mindwright stays dormant until they are present. '
        + 'Run `/mindwright:setup` to install them now — it works even with auto-install disabled — '
        + 'or unset MINDWRIGHT_AUTO_INSTALL to let it self-heal.',
    );
  }

  // No npm on PATH → the background install can never run; escalate now
  // rather than promising a self-heal that cannot happen.
  if (!npmOk()) {
    return sessionStartStdout(
      'mindwright cannot self-heal its native dependencies: `npm` is not on PATH, so the '
        + 'background install cannot run. Install Node.js/npm, then run `/mindwright:setup`. '
        + `Install log: ${installLogPath()}`,
    );
  }

  // Don't repeat "just wait" forever: a non-empty install log on the dormant
  // branch means a prior background install ran yet deps are still absent.
  if (installFailing()) {
    return sessionStartStdout(
      'mindwright tried to install its native dependencies in the background but they are '
        + 'still not present — the install is not succeeding (a missing C/C++ build toolchain '
        + 'for better-sqlite3, no npm-registry access, or low disk are the usual causes). '
        + `Check the install log: ${installLogPath()} — then run \`/mindwright:setup\` to retry `
        + 'with full output.',
    );
  }

  // Models survive plugin updates but node_modules does not, so a returning
  // user can hit this dormant branch with models already cached — don't tell
  // them to redo the ~5 GB download.
  const modelHint = modelsCached()
    ? ''
    : ' Recall additionally needs a one-time ~5 GB model download — run /mindwright:setup when convenient.';
  return sessionStartStdout(
    'mindwright is completing a one-time background install of its local dependencies; '
      + 'memory capture will start automatically within a session or two.'
      + modelHint,
  );
}

// Fire the shim only when spawned as a real hook, not when a test imports
// installingNotice (avoids a stdin-blocking impl load).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runHookShim(
    'session-start',
    new URL('./session-start-impl.js', import.meta.url).href,
    installingNotice,
  );
}
