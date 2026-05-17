// Coverage for lib/native-require.js — the SINGLE uniform resolution mechanism
// every entrypoint uses to load the native deps (better-sqlite3, sqlite-vec,
// @huggingface/transformers, @modelcontextprotocol/sdk) from the PERSISTENT
// data dir (${CLAUDE_PLUGIN_DATA}/node_modules) rather than the ephemeral
// PLUGIN_ROOT the hook/MCP process is launched out of.
//
// WHY THIS FILE IS LOAD-BEARING: the module's defining contract — resolve from
// ${CLAUDE_PLUGIN_DATA}/node_modules, NOT PLUGIN_ROOT — is exactly what the dev
// tree CANNOT exercise indirectly. With CLAUDE_PLUGIN_DATA unset (every other
// suite, store/models/server/health-marker) pluginDataDir()===PLUGIN_ROOT
// (paths.js), so resolution "accidentally works" from the same node_modules
// whether or not the data-dir walk is correct. A regression that rooted
// resolution at PLUGIN_ROOT (or reverted to a bare `import 'better-sqlite3'`)
// would break every native dep in every production install while passing the
// entire rest of the suite. So these tests drive a REAL createRequire
// resolution with CLAUDE_PLUGIN_DATA pointed at a sandbox, which is the only
// way the contract is observable. pluginDataDir() reads process.env at every
// loadNative() call (dataDirRequire→nodeModulesDir→pluginDataDir), so setting
// the env per test drives resolution with no module re-import needed.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNative, loadNativeDefault } from '../lib/native-require.js';

// Temp sandboxes registered here and torn down in afterEach (not as a trailing
// statement) so a failing assertion can't leak a dir under tmpdir() — the same
// teardown hygiene the sibling suites (health-marker/auto-setup/install-worker)
// use. CLAUDE_PLUGIN_DATA is a process-global; save/restore around every test
// so a planted value never bleeds into the next one (node --test isolates
// files in child processes, so this never escapes this file, but per-test
// restore is the established convention here).
const createdRoots = [];
const ORIGINAL_CPD = process.env.CLAUDE_PLUGIN_DATA;
afterEach(() => {
  if (ORIGINAL_CPD === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_CPD;
  while (createdRoots.length) {
    try { rmSync(createdRoots.pop(), { recursive: true, force: true }); }
    catch { /* best-effort tmp cleanup */ }
  }
});

// A sandbox shaped like the persistent data dir: <sandbox>/node_modules/...
// Returns the sandbox path AND points CLAUDE_PLUGIN_DATA at it so the very
// next loadNative() resolves through it. The notional _mindwright-resolve.cjs
// the module seeds createRequire with need not exist (see native-require.js).
function dataDirSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'mw-nr-'));
  createdRoots.push(root);
  process.env.CLAUDE_PLUGIN_DATA = root;
  return root;
}

// Plant node_modules/<name>/ with package.json + the given files. `files` maps
// a relative path (under the package dir) to its source text.
function plantPackage(root, name, pkgJson, files) {
  const pkgDir = join(root, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
  for (const [rel, src] of Object.entries(files)) {
    const dest = join(pkgDir, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, src);
  }
  return pkgDir;
}

test('loadNative resolves a package from ${CLAUDE_PLUGIN_DATA}/node_modules (the data-dir contract)', async () => {
  const root = dataDirSandbox();
  // Uniquely named so it exists ONLY in the sandbox data dir — a correct
  // data-dir-rooted resolution finds it; any PLUGIN_ROOT-rooted regression
  // throws MODULE_NOT_FOUND (the sandbox is under tmpdir(), so the createRequire
  // walk from it never reaches the repo's mindwright/node_modules).
  plantPackage(
    root,
    'mw-fixture-datadir-pkg',
    { name: 'mw-fixture-datadir-pkg', version: '1.0.0', type: 'module', main: 'index.js' },
    { 'index.js': "export const marker = 'from-data-dir-sandbox';\n" },
  );
  const m = await loadNative('mw-fixture-datadir-pkg');
  assert.equal(m.marker, 'from-data-dir-sandbox', 'must resolve the fixture planted in the data dir');
});

test('loadNative resolves from the data dir and NOT the ephemeral PLUGIN_ROOT (the differential pin)', async () => {
  // The single strongest pin of the module's raison d'être. The dev tree has
  // a REAL mindwright/node_modules/better-sqlite3 at PLUGIN_ROOT (npm test
  // requires the native deps). Point CLAUDE_PLUGIN_DATA at an EMPTY sandbox:
  // a correctly data-dir-rooted resolver walks <sandbox> upward (never the
  // repo) and CANNOT find better-sqlite3 ⇒ MUST throw. A regression that
  // rooted at PLUGIN_ROOT (or used a bare specifier) would RESOLVE it and not
  // throw — failing this test. This is exactly the prod-breaking, suite-green
  // gap that motivates this file.
  dataDirSandbox(); // empty node_modules
  await assert.rejects(
    () => loadNative('better-sqlite3'),
    /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
    'an empty data dir must NOT fall back to PLUGIN_ROOT/node_modules',
  );
});

test('loadNative honors a package "exports" SUBPATH map (the @modelcontextprotocol/sdk/server/index.js shape)', async () => {
  const root = dataDirSandbox();
  // server-impl.mjs resolves a subpath like @modelcontextprotocol/sdk/server/
  // index.js; createRequire().resolve must honor the "exports" subpath map.
  plantPackage(
    root,
    'mw-fixture-exports-pkg',
    {
      name: 'mw-fixture-exports-pkg',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './main.js', './sub': './nested/sub-impl.js' },
    },
    {
      'main.js': "export const which = 'main';\n",
      'nested/sub-impl.js': "export const which = 'sub-impl';\n",
    },
  );
  const m = await loadNative('mw-fixture-exports-pkg/sub');
  assert.equal(m.which, 'sub-impl', 'the "./sub" exports entry must resolve nested/sub-impl.js');
});

test('loadNativeDefault returns m.default when the resolved module is CJS with a default (line 65 truthy arm)', async () => {
  const root = dataDirSandbox();
  // No "type":"module" + a module.exports → import() exposes module.exports as
  // `.default`. This is the better-sqlite3 / sqlite-vec shape (CJS consumed as
  // a constructor/namespace) the convenience wrapper exists to normalize.
  plantPackage(
    root,
    'mw-fixture-cjs-default',
    { name: 'mw-fixture-cjs-default', version: '1.0.0', main: 'index.js' },
    { 'index.js': "function Ctor() {}\nCtor.tag = 'cjs-default';\nmodule.exports = Ctor;\n" },
  );
  const d = await loadNativeDefault('mw-fixture-cjs-default');
  assert.equal(typeof d, 'function', 'must return module.exports itself (m.default), not the namespace');
  assert.equal(d.tag, 'cjs-default');
});

test('loadNativeDefault returns the namespace m when there is NO default export (line 65 fallback arm)', async () => {
  const root = dataDirSandbox();
  // ESM with named-only exports → m.default === undefined → the `: m` arm
  // returns the namespace itself. Both arms of line 65 are now asserted.
  plantPackage(
    root,
    'mw-fixture-esm-nodefault',
    { name: 'mw-fixture-esm-nodefault', version: '1.0.0', type: 'module', main: 'index.js' },
    { 'index.js': "export const named = 'esm-named';\n" },
  );
  const m = await loadNativeDefault('mw-fixture-esm-nodefault');
  assert.equal(m.default, undefined, 'no default export → the fallback must NOT be m.default');
  assert.equal(m.named, 'esm-named', 'the fallback returns the whole namespace');
});

test('loadNative rejects on an unresolvable spec (callers depend on this throw → dormant no-op + self-heal)', async () => {
  dataDirSandbox();
  await assert.rejects(
    () => loadNative('mw-fixture-does-not-exist-zzz'),
    /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
  );
});

test('loadNativeDefault rejects on an unresolvable spec (it awaits loadNative — same contract)', async () => {
  dataDirSandbox();
  await assert.rejects(
    () => loadNativeDefault('mw-fixture-does-not-exist-zzz'),
    /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
  );
});
