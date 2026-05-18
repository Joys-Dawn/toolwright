// Resolves the plugin's npm deps from the PERSISTENT data dir's node_modules,
// not the ephemeral PLUGIN_ROOT the process launches from.
//
// WHY NOT a bare `import`: an ESM bare specifier walks node_modules up from
// the importing file (ephemeral PLUGIN_ROOT — no node_modules), and Node's
// ESM resolver does NOT consult NODE_PATH. So this is the single uniform
// mechanism: createRequire() rooted at the data dir (require.resolve honors
// "exports", including subpaths) then dynamic-import the absolute file URL —
// which loads CJS and ESM uniformly (createRequire().require() throws on an
// ESM-only dep on some Node versions; resolve()+import() does not). Do NOT
// "simplify" toward NODE_PATH; ESM cannot honor it.
//
// HARD DEP-FREE RULE: `node:` builtins + lib/paths.js only. loadNative()
// touches a real package ONLY when called (after the readiness gate), never
// at module load — no static bare-npm import to crash a deps-less copy.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { nodeModulesDir } from './paths.js';

// createRequire(base) resolves starting at dirname(base)/node_modules. base is
// a notional (need-not-exist) file inside the data dir so the FIRST lookup is
// <pluginDataDir>/node_modules.
function dataDirRequire() {
  return createRequire(join(nodeModulesDir(), '..', '_mindwright-resolve.cjs'));
}

// Load an npm dep (or subpath) from the persistent data dir. CJS packages
// expose module.exports as `.default` (use `m.default ?? m`). Throws — caller
// is always behind the readiness gate.
export async function loadNative(spec) {
  const req = dataDirRequire();
  const resolved = req.resolve(spec);
  return import(pathToFileURL(resolved).href);
}

// CJS-default convenience (better-sqlite3 / sqlite-vec): normalizes the
// ESM-interop shape so call sites stay readable.
export async function loadNativeDefault(spec) {
  const m = await loadNative(spec);
  return m && m.default !== undefined ? m.default : m;
}
