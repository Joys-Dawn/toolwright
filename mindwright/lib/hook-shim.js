// Shared dep-free hook entry. Each hooks/<name>.js is a thin shim; the
// native-dep logic lives in hooks/<name>-impl.js, dynamic-imported ONLY after
// the readiness gate passes. Split because an ESM import is evaluated when the
// module graph loads, BEFORE the hook body, so no in-body guard can stop the
// throw a deps-less copy gets; quarantining every tainted import behind one
// dynamic import is the only load-safe fix.
//
// HARD RULE: dep-free imports only.

import { depsInstalled } from './ready.js';
import { maybeAutoInstall } from './auto-setup.js';
import { isNativeBindingError, invalidateMarker } from './health-marker.js';
import { logHookError } from './hook-log.js';

// implUrl MUST be pre-resolved by the caller (`new URL('./<name>-impl.js',
// import.meta.url).href`) — a bare relative specifier would resolve against
// THIS file (lib/), not the shim (hooks/). notReadyStdout: stdout while deps
// are missing, a string or a `() => string` thunk invoked ONLY on the dormant
// branch (default is the universal `{}` no-op). SessionStart passes a thunk so
// its install notice is built lazily; a throwing thunk degrades to `{}`.
// The 4th arg is a test seam for the two otherwise-unreachable side-effecting
// branches (deps-absent dormant; deps-present native-binding throw).
export async function runHookShim(
  hookName,
  implUrl,
  notReadyStdout = '{}\n',
  { depsCheck = depsInstalled, autoInstall = maybeAutoInstall, invalidate = invalidateMarker } = {},
) {
  try {
    if (!depsCheck()) {
      // Kick off the single-flight background install, then stay dormant.
      // autoInstall() runs FIRST so the heal is in flight before the notice.
      autoInstall();
      let out;
      try {
        out = typeof notReadyStdout === 'function' ? notReadyStdout() : notReadyStdout;
      } catch {
        // Notice-build failure is best-effort, not a crash — degrade to no-op.
        out = '{}\n';
      }
      process.stdout.write(out);
      return;
    }
    const mod = await import(implUrl);
    await mod.main();
  } catch (err) {
    // Contract: never disrupt the turn.
    try { logHookError(hookName, 'crashed', err); } catch { /* stderr unavailable */ }
    // Self-heal a broken native binding. Shape-classified so it covers a throw
    // from EITHER the impl module load OR a lazy native import inside
    // mod.main(). On a binding error the marker vouches for a `.node` that no
    // longer loads: invalidate it (next session goes dormant) and re-arm the
    // single-flight reinstall. A non-binding throw (ordinary impl bug) must
    // NOT touch the marker — no thrash on a code bug.
    if (isNativeBindingError(err)) {
      try {
        invalidate();
        autoInstall();
      } catch { /* best-effort self-heal; never disrupt the turn */ }
    }
    process.stdout.write('{}\n');
  }
}
