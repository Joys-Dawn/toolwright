// Coverage for lib/hook-shim.js plus the structural invariant the whole
// shim split exists to guarantee: every auto-firing entrypoint must be
// loadable by a Node process where the native deps are ABSENT (a fresh
// marketplace copy, or a plugin update that wiped node_modules). An ESM
// static `import` is evaluated at module-graph load — before any guard —
// so a single tainted static import in an entrypoint re-introduces the
// ERR_MODULE_NOT_FOUND crash this design removed. The last test pins that.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import { runHookShim } from '../lib/hook-shim.js';
import { installingNotice } from '../hooks/session-start.js';
import { installLogPath } from '../lib/auto-setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');

// Teardown hygiene (Principle 3 / Test Isolation), matching the afterEach +
// registry convention the 6 sibling suites use (ready/native-require/
// health-marker/auto-setup/install-worker/offset-init): every mw-shim temp
// dir is created via tmp() so it is torn down in afterEach — NOT as a trailing
// rmSync an earlier failing assertion would skip, leaking the dir under
// tmpdir(). afterEach also unconditionally clears the two globalThis probe
// keys two tests set, so a failed assertion can't leak shared global state.
// (The later structural tests already self-clean via their own try/finally;
// they create dirs directly, not via tmp(), so afterEach leaves them alone.)
const createdDirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'mw-shim-'));
  createdDirs.push(d);
  return d;
}
afterEach(() => {
  delete globalThis.__mwShimRan;
  delete globalThis.__mwImplLoaded;
  while (createdDirs.length) {
    try { rmSync(createdDirs.pop(), { recursive: true, force: true }); }
    catch { /* best-effort tmp cleanup */ }
  }
});

// Capture everything written to process.stdout for the duration of fn().
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

test('runHookShim dispatches to impl.main() and writes no no-op when deps are present', async () => {
  // Deps-present verdict → the ready branch runs: dynamic-import the impl and
  // await main(). main() here records that it ran and writes nothing, so the
  // shim must NOT emit the `{}` no-op. The depsCheck seam expresses "deps
  // present" directly (symmetric with the deps-absent tests below that pass
  // `depsCheck: () => false`) — this test pins the shim's DISPATCH behavior,
  // not depsInstalled's marker logic. Post-Step-2 the real depsInstalled also
  // requires an ABI marker (absent in the dev tree until the self-heal probes);
  // its real integration is covered by test/ready.test.js's PLUGIN_ROOT case,
  // so coupling this shim test to real-tree marker state would only re-add the
  // brittleness the seam exists to remove (see the seam rationale at L84-88).
  const dir = tmp();
  const impl = join(dir, 'impl-ok.mjs');
  writeFileSync(
    impl,
    'export async function main() { globalThis.__mwShimRan = (globalThis.__mwShimRan || 0) + 1; }\n',
  );
  delete globalThis.__mwShimRan;

  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', { depsCheck: () => true }),
  );

  assert.equal(globalThis.__mwShimRan, 1);
  assert.equal(out, '');

  delete globalThis.__mwShimRan;
  rmSync(dir, { recursive: true, force: true });
});

test('runHookShim swallows an impl that throws and emits the {} no-op (never rejects)', async () => {
  const dir = tmp();
  const impl = join(dir, 'impl-throws.mjs');
  writeFileSync(impl, "export async function main() { throw new Error('boom from test'); }\n");

  // Must resolve (not reject) and degrade to the universal hook no-op. The
  // deps-present verdict is the precondition for the path under test — the
  // import+main()+catch — so it is injected explicitly: post-Step-2 the real
  // depsInstalled needs an ABI marker the dev tree lacks, and without this
  // seam the shim would take the dormant branch instead (passing vacuously
  // and firing the real maybeAutoInstall side effect).
  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', { depsCheck: () => true }),
  );

  assert.equal(out, '{}\n');

  rmSync(dir, { recursive: true, force: true });
});

test('runHookShim swallows a missing impl module and emits the {} no-op', async () => {
  const dir = tmp();
  const missing = pathToFileURL(join(dir, 'does-not-exist.mjs')).href;

  // deps-present verdict injected for the same reason as the throwing-impl
  // test above: the path under test is the failed dynamic import() being
  // caught, which only runs on the ready branch.
  const out = await captureStdout(() =>
    runHookShim('t', missing, '{}\n', { depsCheck: () => true }),
  );

  assert.equal(out, '{}\n');

  rmSync(dir, { recursive: true, force: true });
});

// --- The deps-absent dormant branch (the core refactor deliverable) -----
// This branch runs for the real user on every plugin update that wipes
// node_modules. depsInstalled() is parameter-seamed in ready.test.js but
// runHookShim called it with no argument, so the dormant path was only
// reachable by mutating the live plugin's node_modules (a machine-global
// side effect). The injectable depsCheck/autoInstall seam makes it testable
// filesystem-free; these pin its full contract.

test('runHookShim stays dormant when deps are absent: default {} no-op, fires the self-heal, never imports the impl', async () => {
  const dir = tmp();
  const impl = join(dir, 'impl-must-not-load.mjs');
  // Top-level side effect on import: if the dynamic import() ever ran, this
  // global flips — so its staying undefined proves the impl was NOT loaded.
  writeFileSync(impl, 'globalThis.__mwImplLoaded = true;\nexport async function main() {}\n');
  delete globalThis.__mwImplLoaded;
  let autoInstallCalls = 0;

  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', {
      depsCheck: () => false,
      autoInstall: () => {
        autoInstallCalls += 1;
      },
    }),
  );

  assert.equal(out, '{}\n');
  assert.equal(autoInstallCalls, 1);
  assert.equal(globalThis.__mwImplLoaded, undefined);

  delete globalThis.__mwImplLoaded;
  rmSync(dir, { recursive: true, force: true });
});

test('runHookShim writes a custom notReadyStdout (the SessionStart installing notice) verbatim when deps are absent', async () => {
  // SessionStart passes a hookSpecificOutput payload so a deps-less first
  // session explains itself instead of silently dormant. That notice had
  // zero coverage; pin that the exact bytes reach stdout unaltered.
  const payload =
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'mindwright is completing a one-time background install.',
      },
    }) + '\n';

  const out = await captureStdout(() =>
    runHookShim('session-start', 'file:///never-imported.mjs', payload, {
      depsCheck: () => false,
      autoInstall: () => {},
    }),
  );

  assert.equal(out, payload);
});

test('runHookShim never rejects when deps are absent even if the self-heal trigger throws', async () => {
  // Hard contract for every hook: never disrupt the turn. If the self-heal
  // trigger throws, the outer catch must still resolve and degrade to the
  // universal {} no-op — NOT the notReadyStdout (the throw precedes it).
  const out = await captureStdout(() =>
    runHookShim('t', 'file:///never-imported.mjs', 'should-not-appear\n', {
      depsCheck: () => false,
      autoInstall: () => {
        throw new Error('npm probe blew up');
      },
    }),
  );

  assert.equal(out, '{}\n');
});

// --- notReadyStdout as a thunk (Step 8: lazy staged install notice) ------
// The 5 non-SessionStart shims keep the default string `{}\n` (covered
// above). SessionStart passes a () => string thunk so its notice is built
// LAZILY — only on the dormant branch, never on a healthy session — and can
// escalate optimistic → actionable. These pin the runHookShim side of that
// contract; the staging logic itself is unit-tested below via the exported
// installingNotice.

test('runHookShim resolves a notReadyStdout THUNK on the dormant branch and writes its return verbatim', async () => {
  let calls = 0;
  const out = await captureStdout(() =>
    runHookShim('session-start', 'file:///never-imported.mjs', () => {
      calls += 1;
      return 'THUNK-OUTPUT\n';
    }, {
      depsCheck: () => false,
      autoInstall: () => {},
    }),
  );

  assert.equal(out, 'THUNK-OUTPUT\n', 'the thunk return reaches stdout unaltered');
  assert.equal(calls, 1, 'the thunk is invoked exactly once on the dormant branch');
});

test('runHookShim never invokes the notReadyStdout thunk when deps are present (the lazy-notice contract)', async () => {
  // The whole point of the thunk: a healthy session must never build the
  // notice — never read install-state, never spawn `npm --version`. Deps
  // present ⇒ the ready branch runs and notReadyStdout is never touched.
  const dir = tmp();
  const impl = join(dir, 'impl-ok.mjs');
  writeFileSync(impl, 'export async function main() {}\n');
  let calls = 0;

  const out = await captureStdout(() =>
    runHookShim('session-start', pathToFileURL(impl).href, () => {
      calls += 1;
      return 'NOTICE\n';
    }, {
      depsCheck: () => true,
    }),
  );

  assert.equal(calls, 0, 'a healthy session must never build the notice');
  assert.equal(out, '', 'ready branch dispatched to main(); no notice, no no-op');
  rmSync(dir, { recursive: true, force: true });
});

test('runHookShim degrades a THROWING notReadyStdout thunk to the {} no-op (best-effort, not a crash)', async () => {
  // A notice-build failure must not break the never-rejects/always-emit
  // contract, and must NOT be treated as a hook crash (it stays out of the
  // catch's native-binding-heal path). autoInstall still fires exactly once
  // (the dormant-branch self-heal kickoff), never a second time.
  let autoInstallCalls = 0;
  let healed = 0;

  const out = await captureStdout(() =>
    runHookShim('session-start', 'file:///never-imported.mjs', () => {
      throw new Error('notice build failed');
    }, {
      depsCheck: () => false,
      autoInstall: () => { autoInstallCalls += 1; },
      invalidate: () => { healed += 1; },
    }),
  );

  assert.equal(out, '{}\n', 'a throwing thunk degrades to the universal no-op');
  assert.equal(autoInstallCalls, 1, 'self-heal kicked off once; the thunk throw did not re-enter the heal path');
  assert.equal(healed, 0, 'a notice-build failure is not a native-binding error — no marker invalidation');
});

// --- The notice itself (installingNotice, hooks/session-start.js) --------
// Imported directly (the invokedDirectly guard keeps the module-load
// runHookShim call from firing under the test runner). Post-collapse the
// notice has no per-attempt/per-time escalation STATE MACHINE — the deps
// install ONCE into the persistent data dir and survive updates. Branches, in
// order: AUTO_INSTALL=false (disabled) → npm missing (actionable) → a prior
// install already wrote its log yet deps still absent (actionable, a STATELESS
// one-fs-stat check, NOT a counter) → else optimistic (with the
// embedderCached-gated model line). The options object is a real-impl-default
// seam so npm / models / install state are injectable without an actual
// `npm --version` spawn, a ~/.cache dependency, or a real install log on disk.

function withAutoInstall(value, fn) {
  const prev = process.env.MINDWRIGHT_AUTO_INSTALL;
  if (value === undefined) delete process.env.MINDWRIGHT_AUTO_INSTALL;
  else process.env.MINDWRIGHT_AUTO_INSTALL = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_AUTO_INSTALL;
    else process.env.MINDWRIGHT_AUTO_INSTALL = prev;
  }
}

function noticeAC(opts) {
  return JSON.parse(installingNotice(opts)).hookSpecificOutput.additionalContext;
}

test('installingNotice: MINDWRIGHT_AUTO_INSTALL=false → disabled message, and it short-circuits before the npm probe', () => {
  withAutoInstall('false', () => {
    let probed = 0;
    const ac = noticeAC({
      npmOk: () => { probed += 1; return true; },
    });
    assert.match(ac, /auto-install is disabled/);
    assert.match(ac, /MINDWRIGHT_AUTO_INSTALL=false/);
    assert.equal(probed, 0, 'disabled branch must not probe npm');
  });
});

test('installingNotice: npm present, no prior failed attempt → the optimistic message (no escalation wording post-collapse)', () => {
  withAutoInstall(undefined, () => {
    const ac = noticeAC({ npmOk: () => true, installFailing: () => false });
    assert.match(ac, /completing a one-time background install/);
    assert.match(ac, /within a session or two/);
    assert.doesNotMatch(ac, /retries are exhausted/);
    assert.doesNotMatch(ac, /not on PATH/);
  });
});

test('installingNotice: optimistic branch OMITS the ~5 GB model line when models are already cached (behavior-1)', () => {
  // A returning user who already ran /mindwright:setup has the embedder in
  // ~/.cache/huggingface, which survives plugin updates. Telling them to redo
  // a "~5 GB model download" is false for them — alarm or a needless re-run.
  withAutoInstall(undefined, () => {
    const ac = noticeAC({
      npmOk: () => true,
      modelsCached: () => true,
      installFailing: () => false,
    });
    assert.match(ac, /completing a one-time background install/);
    assert.match(ac, /within a session or two/);
    assert.doesNotMatch(
      ac,
      /5 GB model download/,
      'models survive plugin updates — a returning cached user must not be told to redo the download',
    );
  });
});

test('installingNotice: optimistic branch KEEPS the ~5 GB model line when models are absent (genuine first install)', () => {
  withAutoInstall(undefined, () => {
    const ac = noticeAC({
      npmOk: () => true,
      modelsCached: () => false,
      installFailing: () => false,
    });
    assert.match(ac, /completing a one-time background install/);
    assert.match(
      ac,
      /one-time ~5 GB model download — run \/mindwright:setup when convenient/,
      'a genuine first install with no cached models still gets the model-download prompt',
    );
  });
});

test('installingNotice: npm missing → actionable (names /mindwright:setup + the log path)', () => {
  // A no-toolchain host can never build the deps, so promising a self-heal
  // would be false. Surfaced immediately (npmAvailable is consulted only on
  // this dormant branch). The per-attempt/per-time STATE-MACHINE tiers were
  // removed with the collapse; a "npm present but the build keeps failing"
  // host is instead caught by the STATELESS install-log branch (next test),
  // with /mindwright:status as the deeper diagnostic.
  withAutoInstall(undefined, () => {
    const ac = noticeAC({ npmOk: () => false });
    assert.match(ac, /`npm` is not on PATH/);
    assert.match(ac, /\/mindwright:setup/);
    assert.ok(ac.includes(installLogPath()), 'names the install log path so the user can inspect the failure');
  });
});

test('installingNotice: npm present but a prior install already wrote its log (deps still absent) → actionable, NOT optimistic-forever (behavior-1)', () => {
  // The hostile dead-end this fixes: on an un-buildable host (no C/C++
  // toolchain, no registry, disk full) the background `npm install` fails,
  // deps stay absent, and every subsequent SessionStart used to repeat
  // "just wait, a session or two" forever with no signal anything is wrong.
  // installFailing()=true ⇒ the notice must escalate to name the install log
  // and point at /mindwright:setup — the same recovery the header promises —
  // instead of false optimism.
  withAutoInstall(undefined, () => {
    const ac = noticeAC({ npmOk: () => true, installFailing: () => true });
    assert.match(ac, /still not present|not succeeding/);
    assert.match(ac, /\/mindwright:setup/);
    assert.ok(ac.includes(installLogPath()), 'names the install log path so the user can inspect the failure');
    assert.doesNotMatch(
      ac,
      /within a session or two/,
      'a demonstrably-failing install must NOT keep showing the optimistic "just wait" message',
    );
  });
});

test('installingNotice: AUTO_INSTALL=false takes precedence over a failing install log (no self-heal to point at)', () => {
  // Branch order: the opt-out is the truth even if an old log exists — there
  // is no background install to "retry", so the disabled message is correct.
  withAutoInstall('false', () => {
    const ac = noticeAC({ npmOk: () => true, installFailing: () => true });
    assert.match(ac, /auto-install is disabled/);
    assert.doesNotMatch(ac, /run `\/mindwright:setup` to retry/);
  });
});

test('installingNotice: npm-missing takes precedence over the failing-install-log branch (more specific remedy)', () => {
  // Both could be true on a no-npm host that once had a partial log. The
  // npm-not-on-PATH message is the more specific, actionable root cause, so
  // it must win over the generic "install not succeeding" branch.
  withAutoInstall(undefined, () => {
    const ac = noticeAC({ npmOk: () => false, installFailing: () => true });
    assert.match(ac, /`npm` is not on PATH/);
    assert.doesNotMatch(ac, /the install is not succeeding/);
  });
});

// --- The deps-PRESENT native-binding-throw branch (Step 6 self-heal) -----
// depsCheck() passes (the dirs + marker are present) yet the compiled `.node`
// will not load under the running Node ABI — a Node upgrade left a stale
// marker, or node_modules is half-built. The throw surfaces from EITHER the
// `await import(implUrl)` module load OR a lazy `import('better-sqlite3')`
// inside mod.main(); the catch wraps both and isNativeBindingError classifies
// by error SHAPE, so the same heal fires regardless of source. A binding error
// ⇒ invalidate the marker (depsInstalled() flips false next session) + re-arm
// the bounded background reinstall. A non-binding throw (an ordinary impl bug)
// ⇒ leave the marker + reinstall untouched (no spurious thrash). All best-
// effort: the never-rejects / always-`{}` contract holds even if a collaborator
// throws. invalidate/autoInstall are spied; the branch is selected purely by
// the shape of the error the injected impl throws (isNativeBindingError is not
// seamed — it is pure).

test('native-binding error from the impl MODULE LOAD → invalidates marker + re-arms install, still {} and never rejects', async () => {
  // The impl's top-level throws the real WiseLibs/better-sqlite3 #1393 shape
  // (code:'ERR_DLOPEN_FAILED' AND the NODE_MODULE_VERSION message), so the
  // `await import(implUrl)` promise rejects with it. depsCheck:()=>true is the
  // precondition for reaching the import at all.
  const dir = tmp();
  const impl = join(dir, 'impl-abi-broken-on-load.mjs');
  writeFileSync(
    impl,
    "const e = new Error(\"The module '/x/better_sqlite3.node' was compiled against a "
      + 'different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js '
      + 'requires NODE_MODULE_VERSION 137.");\n'
      + "e.code = 'ERR_DLOPEN_FAILED';\n"
      + 'throw e;\n',
  );
  let invalidated = 0;
  let autoInstalled = 0;

  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', {
      depsCheck: () => true,
      invalidate: () => { invalidated += 1; },
      autoInstall: () => { autoInstalled += 1; },
    }),
  );

  assert.equal(out, '{}\n', 'still degrades to the universal no-op (turn never disrupted)');
  assert.equal(invalidated, 1, 'a load-time binding error must invalidate the stale ABI marker');
  assert.equal(autoInstalled, 1, 'and re-arm the bounded background reinstall');

  rmSync(dir, { recursive: true, force: true });
});

test('native-binding error thrown from inside mod.main() (message-only, no code) → same invalidate + re-arm', async () => {
  // Proves the classifier covers the OTHER source: the module loads cleanly,
  // then a lazy native import inside main() throws. Message-only (NO err.code)
  // exercises the message-regex arm of isNativeBindingError independently of
  // the code arm — shape-based detection, source-agnostic.
  const dir = tmp();
  const impl = join(dir, 'impl-abi-broken-in-main.mjs');
  writeFileSync(
    impl,
    'export async function main() {\n'
      + "  throw new Error(\"The module './build/Release/better_sqlite3.node' was compiled "
      + 'against a different Node.js version using NODE_MODULE_VERSION 115. This version of '
      + 'Node.js requires NODE_MODULE_VERSION 137.");\n'
      + '}\n',
  );
  let invalidated = 0;
  let autoInstalled = 0;

  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', {
      depsCheck: () => true,
      invalidate: () => { invalidated += 1; },
      autoInstall: () => { autoInstalled += 1; },
    }),
  );

  assert.equal(out, '{}\n');
  assert.equal(invalidated, 1, 'a binding error from main() is healed identically to one from the load');
  assert.equal(autoInstalled, 1);

  rmSync(dir, { recursive: true, force: true });
});

test('a NON-binding impl throw leaves the marker + reinstall untouched (no spurious thrash), still {}', async () => {
  // An ordinary impl bug (a logic error, a thrown string) must NOT be mistaken
  // for an ABI break — invalidating the marker + reinstalling on every code
  // bug would thrash. isNativeBindingError('boom from test') is false, so
  // neither collaborator runs; the turn still degrades to the {} no-op.
  const dir = tmp();
  const impl = join(dir, 'impl-logic-bug.mjs');
  writeFileSync(impl, "export async function main() { throw new Error('boom from test'); }\n");
  let invalidated = 0;
  let autoInstalled = 0;

  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', {
      depsCheck: () => true,
      invalidate: () => { invalidated += 1; },
      autoInstall: () => { autoInstalled += 1; },
    }),
  );

  assert.equal(out, '{}\n');
  assert.equal(invalidated, 0, 'an ordinary impl bug must NOT invalidate the ABI marker');
  assert.equal(autoInstalled, 0, 'nor re-arm a reinstall (no thrash on a code bug)');

  rmSync(dir, { recursive: true, force: true });
});

test('native-binding heal is best-effort: a throwing invalidate seam still resolves with {} (never rejects)', async () => {
  // Hard contract symmetric with the deps-absent self-heal test above: the
  // catch-path invalidate()+autoInstall() are wrapped INDEPENDENTLY of the
  // stdout write, so a hostile collaborator (a dead fs making invalidate
  // throw) cannot break never-rejects / always-`{}`. invalidate throws before
  // autoInstall is reached, so the re-arm is skipped THIS turn — the next
  // session's dormant-branch autoInstall still heals it (marker logic is the
  // durable signal, not this one best-effort re-arm).
  const dir = tmp();
  const impl = join(dir, 'impl-abi-broken.mjs');
  writeFileSync(
    impl,
    "const e = new Error('dlopen failed');\ne.code = 'ERR_DLOPEN_FAILED';\nthrow e;\n",
  );
  let autoInstalled = 0;

  const out = await captureStdout(() =>
    runHookShim('t', pathToFileURL(impl).href, '{}\n', {
      depsCheck: () => true,
      invalidate: () => { throw new Error('fs is dead'); },
      autoInstall: () => { autoInstalled += 1; },
    }),
  );

  assert.equal(out, '{}\n', 'a throwing invalidate must not break never-rejects / always-{}');
  assert.equal(autoInstalled, 0, 'invalidate threw first → the re-arm is skipped (best-effort, next session heals)');

  rmSync(dir, { recursive: true, force: true });
});

// --- The structural dormancy invariant ---------------------------------

// Every entrypoint that Claude Code (or a detached spawn) loads automatically.
// Each must be statically dep-free; the native code is reached only via a
// dynamic import() AFTER the readiness gate.
const ENTRYPOINTS = [
  'hooks/session-start.js',
  'hooks/session-end.js',
  'hooks/stop.js',
  'hooks/user-prompt-submit.js',
  'hooks/pre-tool-use.js',
  'hooks/post-tool-use-inbox.js',
  // The MCP server is gone. Its replacements: the machine-wide model daemon
  // (detached-spawned by clients) and the CLI every skill invokes. Both must
  // stay statically dep-free — native code only via dynamic import() after
  // the readiness gate, exactly like the hooks.
  'mcp/model-daemon.mjs',
  'scripts/mindwright.mjs',
  'scripts/setup.js',
  'scripts/status.js',
  'scripts/seed-from-repo.js',
  'scripts/seed-loop.js',
  'scripts/install-worker.js',
];

// Extract STATIC import specifiers only. Dynamic `import(` is excluded by the
// negative lookahead; comments and `import.meta` are stripped first so prose
// like "loaded via dynamic import" cannot bridge to a later real specifier.
function staticImportSpecifiers(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
  const noMeta = noLine.replace(/import\.meta/g, '');
  const specs = [];
  const re = /\bimport\b\s*(?!\()(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(noMeta)) !== null) specs.push(m[1]);
  // ESM re-exports resolve their module specifier at LOAD, exactly like a
  // static import: `export * from 'x'` / `export { a } from 'x'` would
  // ERR_MODULE_NOT_FOUND on a deps-less copy just as `import` does. The
  // dormancy walk must see them too — otherwise a future native dep introduced
  // via a barrel re-export silently passes this guard, the exact
  // denylist-style blind spot the whole-graph walk exists to remove.
  const reExport = /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = reExport.exec(noMeta)) !== null) specs.push(m[1]);
  return specs;
}

// Node core modules are present even in a copy with NO node_modules, so
// `node:`-prefixed and bare-builtin specifiers ('node:fs', 'fs', 'path', …)
// never crash a deps-less load. The runtime defines this set — we do not
// hand-maintain it, so it cannot rot.
const CORE = new Set(builtinModules);

function isSafeBuiltin(spec) {
  return spec.startsWith('node:') || CORE.has(spec);
}

// Resolve a relative specifier from an importer's directory to a real file.
// Entrypoints and dep-free libs use explicit-extension specifiers, but the
// candidate list is defensive (extension + index forms) so an unresolved
// relative import fails the test loudly instead of being silently skipped.
function resolveRelative(importerAbs, spec) {
  const base = resolve(dirname(importerAbs), spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')]) {
    if (existsSync(c)) return c;
  }
  return null;
}

// Walk the ENTIRE STATIC import graph reachable from one entrypoint and
// collect every specifier that a node_modules-less copy could NOT resolve at
// ESM load: any bare specifier that is not a Node core builtin (a real npm
// package — better-sqlite3, sqlite-vec, @huggingface/transformers, the MCP
// SDK, OR any future native-tainted module, directly or transitively), plus
// any relative import that fails to resolve. This asserts the ACTUAL dormancy
// invariant (no ERR_MODULE_NOT_FOUND on a deps-less load) instead of a
// hand-curated basename denylist that silently passes the moment a new
// native-using module is added behind an entrypoint.
function collectFromAbs(absEntry) {
  const violations = [];
  const visited = new Set();

  (function walk(absFile, chain) {
    if (visited.has(absFile)) return;
    visited.add(absFile);

    let src;
    try {
      src = readFileSync(absFile, 'utf8');
    } catch {
      violations.push({ spec: '<unreadable>', reason: 'unreadable', via: [...chain, absFile].join(' -> ') });
      return;
    }

    for (const spec of staticImportSpecifiers(src)) {
      if (isSafeBuiltin(spec)) continue;
      if (spec.startsWith('.')) {
        const next = resolveRelative(absFile, spec);
        if (!next) {
          violations.push({ spec, reason: 'unresolved-relative', via: [...chain, absFile].join(' -> ') });
          continue;
        }
        walk(next, [...chain, absFile]);
      } else {
        // Bare, non-builtin: ERR_MODULE_NOT_FOUND on a copy with no
        // node_modules — exactly the crash the shim split exists to prevent.
        violations.push({ spec, reason: 'bare-npm', via: [...chain, absFile].join(' -> ') });
      }
    }
  })(absEntry, []);

  return violations;
}

const collectUnresolvableStatic = (entryRel) => collectFromAbs(join(PLUGIN, entryRel));

test('every auto-firing entrypoint has a statically dep-free transitive graph (deps-less load cannot crash)', () => {
  for (const rel of ENTRYPOINTS) {
    const violations = collectUnresolvableStatic(rel);

    assert.deepEqual(
      violations,
      [],
      `${rel} can ERR_MODULE_NOT_FOUND on a node_modules-less copy. ` +
        `Offending static imports (must move behind a dynamic import() after the readiness gate):\n` +
        violations.map((v) => `  - "${v.spec}" [${v.reason}] via ${v.via}`).join('\n'),
    );
  }
});

test('the dormancy graph check catches a native import reached through a relative hop', () => {
  // Guards the guard: the exact gap a basename denylist had was a native
  // import introduced TRANSITIVELY (entry -> some relative module -> bare
  // npm). Prove the whole-graph walker flags it.
  const dir = mkdtempSync(join(tmpdir(), 'mw-graph-'));
  try {
    writeFileSync(join(dir, 'mid.js'), "import x from 'better-sqlite3';\nexport const y = x;\n");
    writeFileSync(
      join(dir, 'entry.js'),
      "import { y } from './mid.js';\nimport { readFileSync } from 'node:fs';\nexport { y, readFileSync };\n",
    );

    const violations = collectFromAbs(join(dir, 'entry.js'));

    assert.deepEqual(
      violations,
      [{ spec: 'better-sqlite3', reason: 'bare-npm', via: `${join(dir, 'entry.js')} -> ${join(dir, 'mid.js')}` }],
      'a native npm import reached through a relative hop must be flagged with its import chain',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dormancy graph check catches a native dep reached through an `export … from` re-export', () => {
  // Guards the guard against the re-export blind spot: a barrel module that
  // does `export { X } from 'better-sqlite3'` (no literal `import` token)
  // resolves the native specifier at ESM load and would crash a deps-less
  // copy just like an import. The walk must flag it transitively.
  const dir = mkdtempSync(join(tmpdir(), 'mw-graph-reexport-'));
  try {
    writeFileSync(join(dir, 'barrel.js'), "export { default as DB } from 'better-sqlite3';\n");
    writeFileSync(
      join(dir, 'entry.js'),
      "export * from './barrel.js';\nimport { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
    );

    const violations = collectFromAbs(join(dir, 'entry.js'));

    assert.deepEqual(
      violations,
      [{ spec: 'better-sqlite3', reason: 'bare-npm', via: `${join(dir, 'entry.js')} -> ${join(dir, 'barrel.js')}` }],
      'a native dep reached only via `export … from` must be flagged with its chain',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staticImportSpecifiers ignores dynamic import() and captures multi-line static imports', () => {
  const sample = [
    "import { a } from './dep-free-a.js';",
    'import {',
    '  b,',
    "} from './dep-free-b.js';",
    "const { openStore } = await import('../lib/store.js');",
    "// import { x } from './commented-out.js';",
  ].join('\n');

  const specs = staticImportSpecifiers(sample);

  assert.deepEqual(specs, ['./dep-free-a.js', './dep-free-b.js']);
});

test('staticImportSpecifiers also captures `export … from` re-exports (load-time, like imports)', () => {
  const sample = [
    "import { a } from './imp.js';",
    "export * from 'better-sqlite3';",
    "export * as ns from './star-ns.js';",
    "export { x, y as z } from './named-reexport.js';",
    'export const local = 1;', // not a re-export — no module to resolve
    'export default function () {};', // not a re-export
    "export { local };", // local binding re-export — no `from`, loads nothing
  ].join('\n');

  const specs = staticImportSpecifiers(sample);

  // Imports first (source order), then re-exports; the bare native specifier
  // is now visible to the dormancy walk. The three non-`from` export forms
  // contribute nothing.
  assert.deepEqual(specs, [
    './imp.js',
    'better-sqlite3',
    './star-ns.js',
    './named-reexport.js',
  ]);
});

// --- Behavioral backstop for the hook dormancy invariant ---------------

// The structural test above proves the hooks' static graph is dep-free via
// the in-test regex scanner. A regex is NOT an ESM resolver (it strips
// comments but not string/template literals and treats `from` as optional),
// so — unlike the 6 script/mcp entrypoints, each ALSO loaded in a real
// node_modules-less subprocess (seed-loop / setup / install-worker /
// ensure-health-marker / server / status / seed-from-repo) — the 6 hooks had
// NO resolver-truthful check: a future import form the regex fails to capture
// could green that guard while a hook still ships the ERR_MODULE_NOT_FOUND
// the whole shim split exists to prevent. This is that missing behavioral
// backstop — the real Node loader IS the resolver, so it cannot false-green.
//
// Faithful deps-less marketplace state: lib/ + hooks/ copied with NO
// node_modules (paths.js derives PLUGIN_ROOT from its own location → the
// sandbox, so depsInstalled() is false and runHookShim takes the dormant
// branch BEFORE the dynamic import of <name>-impl.js — the -impl files are
// copied but, correctly, never loaded). MINDWRIGHT_AUTO_INSTALL=false makes
// maybeAutoInstall() return at its first line (auto-setup.js) BEFORE any
// lock/spawn/fs-write, so no real `npm install` is ever launched.
const HOOK_ENTRYPOINTS = ENTRYPOINTS.filter((p) => p.startsWith('hooks/'));

// Coverage-matrix invariant pinned independently of the per-entrypoint tests:
// if a hook is dropped from ENTRYPOINTS the matrix below silently shrinks, so
// assert the count in its own focused test.
test('all 6 auto-firing hook entrypoints are behaviorally covered (not just regex-scanned)', () => {
  assert.equal(HOOK_ENTRYPOINTS.length, 6);
});

// The dormant-branch stdout contract per hook, as a named expectation so each
// generated per-entrypoint test asserts ONE behavior with no in-body if/else
// (Conditional Test Logic / One-Behavior-Per-Test): SessionStart emits its
// additionalContext envelope (its notReadyStdout is the installingNotice
// thunk; under AUTO_INSTALL=false the "auto-install is disabled" notice — we
// assert the envelope shape, proving the dormant path ran to completion,
// rather than exact wording); the other 5 emit the universal `{}` no-op.
function assertDormantStdout(rel, stdout) {
  if (rel === 'hooks/session-start.js') {
    const parsed = JSON.parse(stdout);
    assert.equal(
      parsed.hookSpecificOutput.hookEventName,
      'SessionStart',
      `${rel}: dormant stdout must be the SessionStart additionalContext envelope`,
    );
    return;
  }
  assert.equal(
    stdout,
    '{}\n',
    `${rel}: the 5 non-SessionStart shims emit the universal {} no-op while dormant`,
  );
}

// One independent test per entrypoint (parameterized, not a single loop+if/
// else): a failure in one hook no longer aborts the other five in the same
// run, and the self-describing test name says which hook regressed.
for (const rel of HOOK_ENTRYPOINTS) {
  test(`hook ${rel} loads + stays dormant on a real node_modules-less subprocess (resolver-truthful backstop to the regex)`, () => {
    const pluginCopy = mkdtempSync(join(tmpdir(), 'mw-hookdormancy-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'mw-hookdormancy-proj-'));
    try {
      // The hooks' entire static graph is node:* + ../lib/* — copy exactly
      // that. A regression to a static native import (directly or transitively
      // through lib/) surfaces here as the asserted ERR_MODULE_NOT_FOUND,
      // which the regex scanner could in principle miss.
      cpSync(join(PLUGIN, 'lib'), join(pluginCopy, 'lib'), { recursive: true });
      cpSync(join(PLUGIN, 'hooks'), join(pluginCopy, 'hooks'), { recursive: true });

      const res = spawnSync(process.execPath, [join(pluginCopy, rel)], {
        encoding: 'utf8',
        timeout: 20000,
        input: '{}\n',
        env: {
          ...process.env,
          MINDWRIGHT_AUTO_INSTALL: 'false',
          MINDWRIGHT_PROJECT_ROOT: projectDir,
        },
      });

      assert.equal(
        res.status,
        0,
        `${rel}: the dormant shim must exit 0 on a deps-less copy; ` +
          `status=${res.status} signal=${res.signal} stderr=${res.stderr}`,
      );
      assert.ok(
        !/ERR_MODULE_NOT_FOUND/.test(res.stderr),
        `${rel}: a node_modules-less load must not ERR_MODULE_NOT_FOUND — the ` +
          `static graph regressed to a non-dep-free import the regex did not catch. stderr=${res.stderr}`,
      );
      assert.equal(
        res.stderr,
        '',
        `${rel}: the dormant branch writes nothing to stderr (no crash log); got ${JSON.stringify(res.stderr)}`,
      );
      assertDormantStdout(rel, res.stdout);
    } finally {
      for (const d of [pluginCopy, projectDir]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ }
      }
    }
  });
}
