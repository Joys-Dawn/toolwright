// Single source of truth for resolving the plugin's npm dependencies from the
// PERSISTENT data dir (lib/paths.js#nodeModulesDir → ${CLAUDE_PLUGIN_DATA}/
// node_modules), not from the ephemeral PLUGIN_ROOT the hook/MCP process is
// launched out of.
//
// WHY NOT a bare `import 'better-sqlite3'`: an ESM bare specifier resolves by
// walking node_modules upward from the IMPORTING file's location — i.e. the
// ephemeral PLUGIN_ROOT, which no longer contains node_modules. NODE_PATH
// cannot rescue this for ANY entrypoint: Node's ESM resolver does not consult
// it at all ("NODE_PATH is not part of resolving import specifiers" —
// nodejs.org/api/esm.html), and the hooks, the MCP server, and the spawnable
// scripts are ALL ESM. So native-require is the SINGLE uniform resolution
// mechanism for every entrypoint — hooks, the MCP server, and scripts alike,
// identically on POSIX and Windows: resolve the package's real entry file
// with a createRequire() rooted at the data dir (require.resolve honors
// "exports", including subpaths), then dynamic-import that absolute file URL —
// which loads CJS and ESM uniformly (createRequire().require() would throw on
// an ESM-only dep on some Node versions; resolve()+import() does not). The
// .mcp.json server config deliberately carries NO `env.NODE_PATH`: it would be
// dead config — ESM ignores it, and the createRequire walk already finds the
// data-dir node_modules without it (NODE_PATH is only a CJS last-resort
// fallback, reached solely when the normal walk fails — nodejs.org/api/
// modules.html). Do NOT "simplify" any entrypoint toward a NODE_PATH approach;
// ESM cannot honor it.
//
// HARD DEP-FREE RULE (this module is in every gated entrypoint's graph via the
// impl modules): `node:` builtins + lib/paths.js only. paths.js is dep-free.
// loadNative() itself touches a real package, but ONLY when called — after the
// readiness gate has confirmed deps exist — never at module load. No static
// bare-npm import anywhere, so the structural dormancy invariant holds with no
// quarantined import left to crash a deps-less copy.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { nodeModulesDir } from './paths.js';

// createRequire(base) resolves `require('pkg')` starting at dirname(base)/
// node_modules and walking up. We want the FIRST lookup to be
// <pluginDataDir>/node_modules, so base is a notional file directly inside the
// data dir (dirname(base) === pluginDataDir()). The file need not exist —
// createRequire only uses the path to seed the resolver.
function dataDirRequire() {
  return createRequire(join(nodeModulesDir(), '..', '_mindwright-resolve.cjs'));
}

// Load an npm dependency (or a package subpath) from the persistent data dir.
// Returns the imported module namespace. CJS packages expose their
// module.exports as `.default` (and, where the cjs-module-lexer can see them,
// as named exports too); callers that need the CJS default should use
// `m.default ?? m`. Async because the underlying import() is. Throws (caller is
// always behind the readiness gate, and the hook-shim's catch turns any throw
// into the dormant {} no-op + native-binding self-heal).
export async function loadNative(spec) {
  const req = dataDirRequire();
  const resolved = req.resolve(spec);
  return import(pathToFileURL(resolved).href);
}

// CJS-default convenience: better-sqlite3 / sqlite-vec are CJS, consumed as a
// constructor / a namespace with `.load`. This normalizes the ESM-interop shape
// so call sites stay readable.
export async function loadNativeDefault(spec) {
  const m = await loadNative(spec);
  return m && m.default !== undefined ? m.default : m;
}
