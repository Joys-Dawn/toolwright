'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeStubAgentwright } = require('../_helpers/agentwright-stub');

function tmpDir(prefix = 'fw-cfg-init-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const REAL_PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REAL_EXAMPLE_FILE = path.join(REAL_PLUGIN_ROOT, 'forgewright.example.json');

function runConfigInit(projectDir, args = [], extraEnv = {}) {
  const scriptPath = path.join(REAL_PLUGIN_ROOT, 'scripts', 'config-init.js');
  const baseEnv = { ...process.env };
  // Default to the real plugin root so the script can read the real
  // forgewright.example.json. Tests that exercise discovery override
  // CLAUDE_PLUGIN_ROOT and stage their own example file alongside.
  delete baseEnv.CLAUDE_PLUGIN_ROOT;
  const env = {
    ...baseEnv,
    CLAUDE_PLUGIN_ROOT: REAL_PLUGIN_ROOT,
    CLAUDE_PROJECT_DIR: projectDir,
    ...extraEnv,
  };
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectDir, encoding: 'utf8', env,
  });
}

function stagePluginRootWithExample(root) {
  // Copies the real forgewright.example.json to a tmpDir so a test can use it
  // as a fake CLAUDE_PLUGIN_ROOT. The script also uses this dir as the start
  // point for the bootstrap walk-up to find agentwright.
  fs.copyFileSync(REAL_EXAMPLE_FILE, path.join(root, 'forgewright.example.json'));
}

describe('scripts/config-init', () => {
  test('writes .claude/forgewright.json from forgewright.example.json', () => {
    const projectDir = tmpDir();
    try {
      const proc = runConfigInit(projectDir);
      assert.equal(proc.status, 0, proc.stderr);
      const target = path.join(projectDir, '.claude', 'forgewright.json');
      assert.ok(fs.existsSync(target), 'config file was not written');
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      // Must preserve the example's top-level shape
      assert.ok(written.workflows, 'workflows section missing');
      assert.ok(written.reaudit, 'reaudit section missing');
      assert.ok(written.retention, 'retention section missing');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing config without --force', () => {
    const projectDir = tmpDir();
    try {
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.claude', 'forgewright.json'),
        JSON.stringify({ existing: true }), 'utf8');
      const proc = runConfigInit(projectDir);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /already exists/i);
      assert.match(proc.stderr, /--force/);
      // Existing config must be untouched.
      const after = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'forgewright.json'), 'utf8'));
      assert.deepEqual(after, { existing: true });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('--force overwrites an existing config', () => {
    const projectDir = tmpDir();
    try {
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.claude', 'forgewright.json'),
        JSON.stringify({ existing: true }), 'utf8');
      const proc = runConfigInit(projectDir, ['--force']);
      assert.equal(proc.status, 0, proc.stderr);
      const after = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'forgewright.json'), 'utf8'));
      assert.notEqual(after.existing, true, 'existing key must be gone');
      assert.ok(after.workflows, 'workflows section missing after --force overwrite');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('errors with a friendly message when .claude exists as a non-directory file', () => {
    const projectDir = tmpDir();
    try {
      // Create a .claude *file* (not directory) — mkdirSync(recursive:true)
      // throws ENOTDIR/EEXIST in this case.
      fs.writeFileSync(path.join(projectDir, '.claude'), 'not a dir', 'utf8');
      const proc = runConfigInit(projectDir);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /\.claude.*not a directory/i);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('injects agentwright.path when discovery via CLAUDE_PLUGIN_ROOT succeeds', () => {
    const projectDir = tmpDir();
    const pluginCacheRoot = tmpDir();
    try {
      // The bootstrap walk-up starts at CLAUDE_PLUGIN_ROOT, then walks up
      // looking for `<ancestor>/agentwright/coordinator/index.js` (flat
      // dev checkout) or `<ancestor>/agentwright/<version>/coordinator/index.js`
      // (Claude Code's plugin cache layout). Build the dev-checkout shape:
      // pluginCacheRoot/
      //   forgewright/             ← CLAUDE_PLUGIN_ROOT
      //     forgewright.example.json
      //   agentwright/coordinator/index.js
      const fakeForgewrightRoot = path.join(pluginCacheRoot, 'forgewright');
      fs.mkdirSync(fakeForgewrightRoot, { recursive: true });
      stagePluginRootWithExample(fakeForgewrightRoot);
      const stubCli = writeStubAgentwright(pluginCacheRoot, { version: '2.1.5', runId: 'cfg-init-stub' });
      const proc = runConfigInit(projectDir, [], { CLAUDE_PLUGIN_ROOT: fakeForgewrightRoot });
      assert.equal(proc.status, 0, proc.stderr);
      const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'forgewright.json'), 'utf8'));
      assert.equal(written.agentwright.path, stubCli);
      assert.match(proc.stdout, /Discovered agentwright at/);
      assert.match(proc.stdout, /agentwright version: 2\.1\.5/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(pluginCacheRoot, { recursive: true, force: true });
    }
  });

  test('warns when agentwright is not discoverable', () => {
    const projectDir = tmpDir();
    const emptyPluginRoot = tmpDir();
    try {
      // CLAUDE_PLUGIN_ROOT pointed at an isolated dir with the example file
      // staged but no sibling agentwright → bootstrap finds nothing.
      stagePluginRootWithExample(emptyPluginRoot);
      const proc = runConfigInit(projectDir, [], { CLAUDE_PLUGIN_ROOT: emptyPluginRoot });
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /agentwright CLI was not discovered/);
      const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'forgewright.json'), 'utf8'));
      // example file ships agentwright.path = null
      assert.equal(written.agentwright.path, null);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(emptyPluginRoot, { recursive: true, force: true });
    }
  });

  test('-f short flag is equivalent to --force', () => {
    const projectDir = tmpDir();
    try {
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.claude', 'forgewright.json'),
        JSON.stringify({ existing: true }), 'utf8');
      const proc = runConfigInit(projectDir, ['-f']);
      assert.equal(proc.status, 0, proc.stderr);
      const after = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'forgewright.json'), 'utf8'));
      assert.ok(after.workflows);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
