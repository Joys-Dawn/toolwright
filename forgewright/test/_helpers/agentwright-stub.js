'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Scaffolds a fake agentwright CLI under <root>/agentwright/coordinator/index.js
 * plus the matching .claude-plugin/plugin.json. forgewright's bridge only
 * checks that the CLI file exists and reads the plugin.json for the version —
 * it never invokes the stub script. (Pipeline phases are atomic from
 * forgewright's POV: the leader drives /agentwright:audit-run +
 * /agentwright:check-deltas via the Skill tool, and shells out to
 * `<cli> cleanup-snapshot` itself — none of that runs in unit tests.) The
 * stub script is therefore a no-op; it exists only so `fs.existsSync(cli)`
 * passes during discovery.
 *
 * The `runId` option is retained for back-compat with existing test sites
 * that pass it; it is unused by the stub.
 *
 * @param {string} root - Directory to scaffold under (typically a tmpDir).
 * @param {{ version: string, runId?: string }} opts
 * @returns {string} Absolute path to the stub CLI.
 */
function writeStubAgentwright(root, { version } = {}) {
  if (!version) throw new Error('writeStubAgentwright requires { version }');
  const pluginDir = path.join(root, 'agentwright');
  const coordinatorDir = path.join(pluginDir, 'coordinator');
  const pluginMetaDir = path.join(pluginDir, '.claude-plugin');
  fs.mkdirSync(coordinatorDir, { recursive: true });
  fs.mkdirSync(pluginMetaDir, { recursive: true });
  fs.writeFileSync(path.join(coordinatorDir, 'index.js'),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, args: process.argv.slice(2) }));\n',
    'utf8');
  fs.writeFileSync(path.join(pluginMetaDir, 'plugin.json'),
    JSON.stringify({ name: 'agentwright', version }), 'utf8');
  return path.join(coordinatorDir, 'index.js');
}

module.exports = { writeStubAgentwright };
