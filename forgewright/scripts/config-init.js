#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = 'forgewright.default.json';
const TARGET_FILE = 'forgewright.json';

function parseArgs(argv) {
  const args = { force: false };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') args.force = true;
  }
  return args;
}

function tryDiscoverAgentwrightCli() {
  try {
    const bridge = require('../coordinator/agentwright-bridge');
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const cli = bridge.discoverAgentwrightCli(cwd);
    if (!cli) return { cli: null, version: null };
    const version = bridge.readAgentwrightVersion(cli);
    return { cli, version };
  } catch (err) {
    return { cli: null, version: null, error: err.message };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const sourcePath = path.join(pluginRoot, DEFAULT_FILE);
  const claudeDir = path.join(projectRoot, '.claude');
  const targetPath = path.join(claudeDir, TARGET_FILE);

  if (!fs.existsSync(sourcePath)) {
    console.error(`Bundled default config not found: ${sourcePath}`);
    process.exit(1);
  }

  // With recursive:true, mkdirSync is silent when the path is already a
  // directory and throws ENOTDIR when the path exists as a non-directory file
  // (it does NOT throw EEXIST in that case on modern Node). Cover both codes
  // so the user-friendly error fires instead of a raw rethrow.
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    if (err.code === 'ENOTDIR' || err.code === 'EEXIST') {
      console.error(`${path.relative(projectRoot, claudeDir)} exists but is not a directory.`);
      process.exit(1);
    }
    throw err;
  }

  if (fs.existsSync(targetPath) && !args.force) {
    console.error(`Config already exists: ${path.relative(projectRoot, targetPath)}`);
    console.error('Re-run with --force to overwrite.');
    process.exit(1);
  }

  // Load the default, optionally inject agentwright.path from discovery.
  const defaultConfig = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const discovery = tryDiscoverAgentwrightCli();
  if (discovery.cli) {
    defaultConfig.agentwright = defaultConfig.agentwright || {};
    defaultConfig.agentwright.path = discovery.cli;
  }

  fs.writeFileSync(targetPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');

  console.log(`Wrote default config: ${path.relative(projectRoot, targetPath)}`);
  if (discovery.cli) {
    console.log(`Discovered agentwright at: ${discovery.cli}`);
    if (discovery.version) {
      console.log(`agentwright version: ${discovery.version}`);
    }
  } else {
    console.log('Warning: agentwright CLI was not discovered.');
    console.log('Install it via: /plugin marketplace add Joys-Dawn/toolwright; /plugin install agentwright@Joys-Dawn/toolwright');
    console.log('Once agentwright is installed, your next /forgewright:workflow-run will auto-discover and persist its path.');
  }
  console.log('Edit any value to customize. Delete the file to fall back to built-in defaults.');
}

main();
