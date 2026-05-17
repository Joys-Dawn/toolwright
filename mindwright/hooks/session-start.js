#!/usr/bin/env node
// SessionStart hook — dependency-free shim.
//
// Real logic is in hooks/session-start-impl.js, loaded via dynamic import
// ONLY after lib/hook-shim.js confirms the native deps are installed (see
// that file for the full rationale). While the self-healing background
// `npm install` runs, this emits a one-line user-visible notice via
// SessionStart additionalContext — a deps-less first session explains itself
// instead of going silently dormant and looking broken.
//
// The notice is a THUNK (computed lazily, only on the dormant branch — a
// healthy session never enters it). It is intentionally simple: the deps now
// install ONCE into the persistent data dir and survive plugin updates, so the
// old per-attempt/per-time escalation STATE MACHINE (mechanism 4 — a persisted
// attempt counter) was removed with the auto-setup.js collapse. Three cases
// get an actionable message instead of false optimism:
//   - MINDWRIGHT_AUTO_INSTALL=false: there IS no automatic self-heal; say the
//     dormancy plainly and point at /mindwright:setup — runInstallSync (its
//     sync path) is NOT gated by this opt-out, so it is the one manual install
//     that still works. (The old text said "npm install in the plugin
//     directory" — wrong: deps resolve only from the persistent data dir, not
//     PLUGIN_ROOT, so that instruction looped the user forever.)
//   - `npm` not on PATH: the no-toolchain host can never build the deps;
//     point at /mindwright:setup.
//   - a prior background install already wrote to the install log yet the
//     deps are STILL absent (we only run on the dormant branch): the build is
//     not succeeding (no C/C++ compiler, no npm registry, disk full, EACCES)
//     — point at the log + /mindwright:setup. This is a STATELESS check (one
//     fs stat), NOT the removed counter; it only stops the "just wait"
//     message from lying forever on an un-buildable host.
// Otherwise (no attempt has produced output yet) the message is optimistic.
// `npmAvailable()` (a ≤10 s spawnSync) is consulted ONLY on the deps-missing
// dormant branch — the transient bootstrap window, never steady state.
//
// HARD RULE: dep-free imports only. ../lib/hook-shim.js, ../lib/auto-setup.js
// and ../lib/paths.js are each dep-free (auto-setup.js is already in this
// entrypoint's transitive graph via hook-shim.js, and paths.js is already in
// it via auto-setup.js → paths.js — so neither adds a module to the dormancy
// graph — verified by the ENTRYPOINTS invariant test).

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

// () => string thunk. runHookShim invokes it ONLY when deps are absent, AFTER
// it has fired maybeAutoInstall(). Never throws by construction (npmAvailable
// is itself never-throw best-effort), and even if it did the shim degrades the
// dormant write to the `{}` no-op.
//
// Real-impl default for the "a prior background install already produced
// output yet the deps are STILL absent" signal. Stateless (one fs stat on the
// dormant branch — NOT the removed per-attempt counter). Never throws: a
// hostile fs or a TOCTOU unlink between the existsSync and the statSync ⇒
// false ⇒ the caller stays optimistic (the notice must never throw — its
// return is written verbatim as the dormant hook stdout).
function installLogHasOutput() {
  try {
    return existsSync(installLogPath()) && statSync(installLogPath()).size > 0;
  } catch {
    return false;
  }
}

// The options object is a pure test seam (real-impl defaults, the repo
// convention). runHookShim calls it with zero args → all defaults → the real
// npmAvailable/embedderCached/install-log check; tests inject deterministic
// npm / model / install state without an actual `npm --version` spawn, a
// ~/.cache dependency, or a real install log on disk.
export function installingNotice({
  npmOk = npmAvailable,
  modelsCached = embedderCached,
  installFailing = installLogHasOutput,
} = {}) {
  // MINDWRIGHT_AUTO_INSTALL=false makes maybeAutoInstall() a deliberate no-op
  // (auto-setup.js), so claiming "an install is completing automatically"
  // would flatly contradict the documented "stays dormant" behavior.
  if (process.env.MINDWRIGHT_AUTO_INSTALL === 'false') {
    return sessionStartStdout(
      'mindwright native dependencies are not installed and auto-install is disabled '
        + '(MINDWRIGHT_AUTO_INSTALL=false) — mindwright stays dormant until they are present. '
        + 'Run `/mindwright:setup` to install them now — it works even with auto-install disabled — '
        + 'or unset MINDWRIGHT_AUTO_INSTALL to let it self-heal.',
    );
  }

  // Probe npm lazily. A missing toolchain can never succeed, so escalate
  // immediately rather than promising a self-heal that cannot run.
  if (!npmOk()) {
    return sessionStartStdout(
      'mindwright cannot self-heal its native dependencies: `npm` is not on PATH, so the '
        + 'background install cannot run. Install Node.js/npm, then run `/mindwright:setup`. '
        + `Install log: ${installLogPath()}`,
    );
  }

  // The deps install ONCE into the persistent data dir; the per-attempt
  // escalation counter was deliberately removed in the collapse. But repeating
  // "just wait, a session or two" FOREVER on a host where the install can
  // never succeed (no C/C++ toolchain for better-sqlite3, no npm-registry
  // access, disk full, EACCES) is a hostile dead-end. STATELESS failure signal
  // — NOT a resurrected counter: this thunk only runs while deps are absent
  // (the dormant branch), so a non-empty install log means a prior background
  // `npm install` already produced output yet the deps still are not present
  // ⇒ it is not succeeding. Surface the actionable pointer the module header
  // promises recovery through, instead of making the user independently
  // suspect a problem and hunt for /mindwright:status. (installLogHasOutput
  // never throws — a hostile fs degrades to optimistic, not a crash.)
  if (installFailing()) {
    return sessionStartStdout(
      'mindwright tried to install its native dependencies in the background but they are '
        + 'still not present — the install is not succeeding (a missing C/C++ build toolchain '
        + 'for better-sqlite3, no npm-registry access, or low disk are the usual causes). '
        + `Check the install log: ${installLogPath()} — then run \`/mindwright:setup\` to retry `
        + 'with full output.',
    );
  }

  // The ~5 GB model download lives in ~/.cache/huggingface and SURVIVES plugin
  // updates (lib/paths.js#embedderCached / lib/ready.js#modelsReady), unlike
  // node_modules which is wiped on every update and re-enters this dormant
  // branch. A returning user whose models are already cached must NOT be told
  // to redo the download — that reads as "the update deleted my 5 GB models"
  // (false) or triggers a needless /mindwright:setup re-run. Gate the sentence
  // on model presence exactly as the deps-present path already does
  // (session-start-impl.js: `if (!embedderCached())`). modelsCached is an
  // injectable real-impl-default seam — same convention as state/npmOk/now —
  // so this branch stays hermetically testable without a ~/.cache dependency.
  const modelHint = modelsCached()
    ? ''
    : ' Recall additionally needs a one-time ~5 GB model download — run /mindwright:setup when convenient.';
  return sessionStartStdout(
    'mindwright is completing a one-time background install of its local dependencies; '
      + 'memory capture will start automatically within a session or two.'
      + modelHint,
  );
}

// Only fire the shim when spawned as a real hook (node hooks/session-start.js),
// not when a unit test imports installingNotice — the same invokedDirectly
// guard the other dep-free entrypoints use so the thunk is testable in
// isolation without triggering a stdin-blocking impl load.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runHookShim(
    'session-start',
    new URL('./session-start-impl.js', import.meta.url).href,
    installingNotice,
  );
}
