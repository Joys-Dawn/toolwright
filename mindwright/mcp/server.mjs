#!/usr/bin/env node
// mindwright MCP server — dependency-free shim.
//
// The real server is mcp/server-impl.mjs (statically imports the MCP SDK +
// the native-dep store/models), loaded via dynamic import ONLY after the
// deps are installed.
//
// A deps-less plugin copy must NOT speak a half-broken protocol: stdout here
// is the JSON-RPC channel, so this shim never writes to it. Instead it kicks
// off the self-healing background install, logs to stderr, and exits cleanly
// so the MCP client marks the server unavailable until a later session
// (post-heal) brings it up. See lib/ready.js for the gate rationale.

import { depsInstalled } from '../lib/ready.js';
import { maybeAutoInstall, installLogPath } from '../lib/auto-setup.js';

async function run() {
  if (!depsInstalled()) {
    maybeAutoInstall();
    process.stderr.write(
      '[mindwright/mcp] native dependencies not installed yet — server unavailable this session; '
        + `a background install was triggered (log: ${installLogPath()}). `
        + 'It will come up automatically once deps are present.\n',
    );
    process.exit(0);
  }
  const mod = await import(new URL('./server-impl.mjs', import.meta.url).href);
  await mod.main();
}

run().catch((err) => {
  process.stderr.write(
    `[mindwright/mcp] fatal: ${err && err.stack ? err.stack : err && err.message ? err.message : err}\n`,
  );
  process.exit(1);
});
