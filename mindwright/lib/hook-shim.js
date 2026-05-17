// Shared dependency-free hook entry. Every hooks/<name>.js is now a 2-line
// shim that calls this; all the real (native-dep-importing) logic lives in
// hooks/<name>-impl.js and is loaded via dynamic import ONLY after the
// readiness gate passes.
//
// Why a split instead of converting each tainted import to a dynamic one in
// place: an ESM `import '../lib/store.js'` is evaluated when the hook module's
// graph loads — BEFORE the hook body, so no in-body guard can prevent the
// ERR_MODULE_NOT_FOUND a deps-less copy throws. Quarantining every tainted
// import behind one dynamic import of the impl module is the only structurally
// sound fix, and it needs zero transitive-taint tracing: this file imports
// nothing but dep-free modules, so the shim is provably load-safe regardless
// of what the impl pulls in.
//
// HARD RULE: dep-free imports only (./ready.js, ./auto-setup.js,
// ./hook-log.js are each dep-free).

import { depsInstalled } from './ready.js';
import { maybeAutoInstall } from './auto-setup.js';
import { isNativeBindingError, invalidateMarker } from './health-marker.js';
import { logHookError } from './hook-log.js';

// hookName: for stderr error logs. implUrl: a fully-resolved module URL the
// caller builds with `new URL('./<name>-impl.js', import.meta.url).href` —
// MUST be pre-resolved, because a bare relative specifier passed to import()
// here would resolve against THIS file (lib/), not the shim (hooks/).
// notReadyStdout: the exact stdout the hook emits while deps are missing —
// either a string OR a `() => string` thunk invoked ONLY on the dormant
// branch. Defaults to the universal hook no-op `{}` (Claude Code reads that as
// "hook did nothing"); the 5 non-SessionStart shims keep the default string.
// SessionStart passes a thunk so its install notice (optimistic, or actionable
// when AUTO_INSTALL=false / npm missing — via a lazy npmAvailable() probe) is
// computed LAZILY — a healthy session never enters this branch, so never builds the
// notice or pays the probe. A throwing thunk degrades to the `{}` no-op (a
// notice-build failure must not break the never-rejects/always-emit contract,
// and is not a hook "crash" — it stays out of the catch's crash path).
//
// The 4th arg is a test seam. TWO side-effecting branches are otherwise only
// reachable by mutating the live plugin's node_modules (a machine-global side
// effect): (1) the deps-absent dormant branch — the entire reason this split
// exists, hit for real on every node_modules-wiping plugin update; (2) the
// deps-present native-binding-throw branch (Step 6) — deps ARE present but the
// compiled `.node` will not load under the running Node ABI (a Node upgrade, a
// half-built node_modules), so depsCheck() passes yet `await import(implUrl)`
// (or a lazy native import inside mod.main()) throws ERR_DLOPEN_FAILED. Both
// need the self-heal exercised WITHOUT touching the filesystem or spawning npm.
// depsCheck/autoInstall/invalidate default to the real implementations
// (depsInstalled is itself already parameter-seamed in ready.test.js); tests
// inject a false deps check / a shaped throw + spies. isNativeBindingError is
// NOT seamed: it is pure and shape-driven, so a test selects the branch purely
// by the shape of the error it makes the impl throw.
export async function runHookShim(
  hookName,
  implUrl,
  notReadyStdout = '{}\n',
  { depsCheck = depsInstalled, autoInstall = maybeAutoInstall, invalidate = invalidateMarker } = {},
) {
  try {
    if (!depsCheck()) {
      // Kick off the self-healing background install (single-flight,
      // non-blocking, best-effort) and stay dormant for this session.
      // autoInstall() runs FIRST purely so the heal is already in flight before
      // the dormant notice is emitted (trigger the fix, then explain it). The
      // notice is independent of it — installingNotice reads only env / a lazy
      // npm probe / model-cache state / whether a prior install already wrote
      // its log, never a persisted attempt counter (the per-attempt
      // install-state machine was removed in the auto-setup.js collapse). It is
      // optimistic until an attempt has demonstrably produced output without
      // resolving the deps, then escalates to an actionable pointer.
      autoInstall();
      let out;
      try {
        out = typeof notReadyStdout === 'function' ? notReadyStdout() : notReadyStdout;
      } catch {
        // A notice-build failure is best-effort, not a hook crash — degrade to
        // the universal no-op rather than falling through to the catch.
        out = '{}\n';
      }
      process.stdout.write(out);
      return;
    }
    const mod = await import(implUrl);
    await mod.main();
  } catch (err) {
    // Same contract every hook already had: never disrupt the turn.
    try { logHookError(hookName, 'crashed', err); } catch { /* stderr unavailable */ }
    // Self-heal a broken native binding (implementation-2 / correctness-2).
    // Shape-classified so it covers a throw from EITHER the `await
    // import(implUrl)` module load OR a lazy `import('better-sqlite3')` inside
    // mod.main() — the catch already wraps both, and isNativeBindingError does
    // not need to know the source. On a binding error the present marker is
    // vouching for a `.node` that no longer loads: invalidate it so
    // depsInstalled() flips false (next session goes dormant) and re-arm the
    // single-flight background reinstall now so the heal starts at once. A
    // NON-binding throw (an ordinary impl bug — `boom from test`, a logic
    // error) must NOT touch the marker or reinstall: no spurious thrash on a
    // code bug. There is no per-attempt escalation bound (the bounded-backoff
    // "mechanism 4" was removed in the auto-setup.js collapse): maybeAutoInstall
    // is single-flight per session via acquireLock, so on a permanently
    // un-buildable host it retries best-effort each session by design —
    // recovery is /mindwright:status pointing at the install log, exactly as
    // session-start.js's header states. All best-effort and wrapped
    // independently of the stdout write: a throw HERE (a hostile seam, a dead
    // fs) must not break the never-rejects / always-`{}` contract.
    if (isNativeBindingError(err)) {
      try {
        invalidate();
        autoInstall();
      } catch { /* best-effort self-heal; never disrupt the turn */ }
    }
    process.stdout.write('{}\n');
  }
}
