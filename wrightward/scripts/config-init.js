#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const EXAMPLE_FILE = 'wrightward.example.json';
const TARGET_FILE = 'wrightward.json';

function parseArgs(argv) {
  const args = { force: false };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') args.force = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const sourcePath = path.join(pluginRoot, EXAMPLE_FILE);
  const claudeDir = path.join(projectRoot, '.claude');
  const targetPath = path.join(claudeDir, TARGET_FILE);

  if (!fs.existsSync(sourcePath)) {
    console.error(`Bundled default config not found: ${sourcePath}`);
    process.exit(1);
  }

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error(`${path.relative(projectRoot, claudeDir)} exists but is not a directory.`);
      process.exit(1);
    }
    throw err;
  }

  const copyFlags = args.force ? 0 : fs.constants.COPYFILE_EXCL;
  try {
    fs.copyFileSync(sourcePath, targetPath, copyFlags);
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error(`Config already exists: ${path.relative(projectRoot, targetPath)}`);
      console.error('Re-run with --force to overwrite.');
      process.exit(1);
    }
    throw err;
  }

  console.log(`Wrote default config: ${path.relative(projectRoot, targetPath)}`);
  console.log('Edit any value to customize. Delete the file to fall back to built-in defaults.');
}

main();
