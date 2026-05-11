'use strict';

const fs = require('fs');
const path = require('path');

let semver;
try {
  semver = require('semver');
} catch (_) {
  semver = null;
}

const { readJson, writeJson } = require('./io');
const { configFile } = require('./paths');

const REQUIRED_VERSION = '2.1.5';

function requireSemver() {
  if (!semver) {
    throw new Error(
      'forgewright requires the "semver" npm package. ' +
      'Install dependencies: cd to the forgewright plugin directory and run `npm install`.'
    );
  }
  return semver;
}

function loadConfiguredCliPath(cwd) {
  const cfg = readJson(configFile(cwd));
  return cfg?.agentwright?.path || null;
}

function isCliCandidate(candidate) {
  return candidate && fs.existsSync(candidate);
}

/**
 * Bootstrap fallback: walk up from CLAUDE_PLUGIN_ROOT looking for a sibling
 * `agentwright/<version>/coordinator/index.js` (the Claude Code plugin cache
 * layout) or a flat `agentwright/coordinator/index.js` (development checkout).
 * The cache layout is undocumented and version-bound — this is intentionally a
 * one-time bootstrap path. The steady-state lookup is `agentwright.path` in
 * `.claude/forgewright.json`, written by `/forgewright:config-init`.
 */
function discoverViaBootstrap() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return null;
  const sv = semver;
  let cur = path.resolve(root, '..');
  for (let i = 0; i < 10; i++) {
    const directCli = path.join(cur, 'agentwright', 'coordinator', 'index.js');
    if (isCliCandidate(directCli)) return directCli;

    const versionedDir = path.join(cur, 'agentwright');
    if (fs.existsSync(versionedDir)) {
      let entries;
      try {
        entries = fs.readdirSync(versionedDir, { withFileTypes: true });
      } catch (_) {
        entries = [];
      }
      const versions = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => sv && sv.valid(name));
      if (sv) versions.sort(sv.rcompare);
      for (const v of versions) {
        const cli = path.join(versionedDir, v, 'coordinator', 'index.js');
        if (isCliCandidate(cli)) return cli;
      }
    }

    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function discoverAgentwrightCli(cwd) {
  const fromConfig = loadConfiguredCliPath(cwd);
  if (isCliCandidate(fromConfig)) return fromConfig;
  return discoverViaBootstrap();
}

// Threat model — `.claude/forgewright.json` is treated as user-controlled but
// it can end up committed to a repo. If an attacker plants `agentwright.path`
// pointing at an arbitrary file on disk, the leader LLM later invokes
// `node <agentwrightCli> cleanup-snapshot ...` per the workflow-run skill,
// which would execute the attacker's script. The mitigation here is plugin
// identity: the sibling `.claude-plugin/plugin.json` must declare the plugin's
// name as "agentwright". A drop-in `/tmp/evil.js` won't have that sibling, so
// it fails identity verification before forgewright surfaces the path to the
// leader. An attacker has to ALSO stage a fake plugin layout (directory +
// plugin.json with the right name) at their malicious target — significantly
// raises the bar over a one-line config redirect.
function readAgentwrightVersion(cli) {
  if (!cli) return null;
  // Plugin layout: <root>/coordinator/index.js with sibling .claude-plugin/plugin.json
  const pluginRoot = path.resolve(path.dirname(cli), '..');
  const pluginJsonPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const pluginJson = readJson(pluginJsonPath);
  if (!pluginJson || pluginJson.name !== 'agentwright') return null;
  return pluginJson.version || null;
}

function installInstruction() {
  return [
    'Install agentwright:',
    '  /plugin marketplace add Joys-Dawn/toolwright',
    '  /plugin install agentwright@Joys-Dawn/toolwright',
    'If installed elsewhere, set "agentwright.path" in .claude/forgewright.json',
    '(run /forgewright:config-init to populate it).',
  ].join('\n');
}

/**
 * Updates `agentwright.path` in `.claude/forgewright.json` surgically — only
 * that one field, every other key (custom workflows, retention, reaudit,
 * tests) is preserved verbatim. No-ops when the config file doesn't exist
 * yet, so the first workflow run before `/forgewright:config-init` doesn't
 * silently create a half-populated config that would then block the eventual
 * config-init.
 */
function persistAgentwrightPath(cwd, cli) {
  const file = configFile(cwd);
  const existing = readJson(file);
  if (!existing) return;
  existing.agentwright = existing.agentwright || {};
  existing.agentwright.path = cli;
  writeJson(file, existing);
}

/**
 * Resolves the agentwright CLI to use for this workflow start, auto-recovering
 * from stale stored paths.
 *
 * Logic:
 *   1. Read the stored path from `.claude/forgewright.json` and its version.
 *   2. Walk the plugin cache (bootstrap) to find the highest-semver candidate.
 *   3. If the bootstrap find has a strictly higher version than the stored
 *      path, prefer it — this is the auto-rebind path. It recovers from
 *      "user upgraded agentwright; old version still on disk; stored path
 *      still points at the old version dir" automatically — no manual
 *      recovery step needed.
 *   4. Persist the resolved path back to forgewright.json so future workflow
 *      starts skip the discovery walk (but only when the config file already
 *      exists — see persistAgentwrightPath).
 *   5. Enforce the minimum-version pin. If still below REQUIRED_VERSION after
 *      auto-rebind, the user must upgrade agentwright itself.
 *
 * A non-cache install (e.g. user-set `agentwright.path` pointing at a dev
 * checkout) wins on ties — bootstrap only overrides when strictly newer.
 */
function requireAgentwright(cwd) {
  const sv = requireSemver();

  const stored = loadConfiguredCliPath(cwd);
  // Treat a stored path that no longer exists on disk as "not stored" — that
  // way an invalid path falls through to the bootstrap walk and, failing
  // that, surfaces "CLI not found" rather than the misleading "could not
  // determine agentwright version at <stale path>".
  let cli = isCliCandidate(stored) ? stored : null;
  let version = cli ? readAgentwrightVersion(cli) : null;

  const fresh = discoverViaBootstrap();
  const freshVersion = fresh && fresh !== cli ? readAgentwrightVersion(fresh) : null;

  if (freshVersion && (!version || sv.gt(freshVersion, version))) {
    cli = fresh;
    version = freshVersion;
  }

  if (!cli) {
    throw new Error(`agentwright CLI not found.\n${installInstruction()}`);
  }
  if (!version) {
    throw new Error(`Could not determine agentwright version at ${cli}.\n${installInstruction()}`);
  }

  if (cli !== stored) {
    persistAgentwrightPath(cwd, cli);
  }

  if (!sv.gte(version, REQUIRED_VERSION)) {
    throw new Error(
      `forgewright requires agentwright >= ${REQUIRED_VERSION}; found ${version} at ${cli}.\n` +
      `Upgrade: /plugin update agentwright@Joys-Dawn/toolwright`
    );
  }
  return { cli, version };
}

module.exports = {
  REQUIRED_VERSION,
  discoverAgentwrightCli,
  readAgentwrightVersion,
  requireAgentwright,
};
