'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../../coordinator/agentwright-bridge');
const { writeStubAgentwright: writeStub } = require('../_helpers/agentwright-stub');

function tmpDir(prefix = 'fw-bridge-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStubAgentwright(root, version) {
  return writeStub(root, { version, runId: 'stub-run-id' });
}

describe('agentwright-bridge', () => {
  // Snapshot CLAUDE_PLUGIN_ROOT before each test and restore after. Bootstrap
  // discovery reads it, so a stray ambient value would silently change outcomes.
  let prevPluginRoot;
  let hadPluginRoot;
  beforeEach(() => {
    hadPluginRoot = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_PLUGIN_ROOT');
    prevPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });
  afterEach(() => {
    if (hadPluginRoot) process.env.CLAUDE_PLUGIN_ROOT = prevPluginRoot;
    else delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  describe('discoverAgentwrightCli', () => {
    test('prefers configured agentwright.path when present', () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({ agentwright: { path: cli } }), 'utf8');
        const found = bridge.discoverAgentwrightCli(cwd);
        assert.equal(found, cli);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('falls back to bootstrap walk-up when config path is missing', () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        process.env.CLAUDE_PLUGIN_ROOT = path.join(stubRoot, 'forgewright');
        fs.mkdirSync(process.env.CLAUDE_PLUGIN_ROOT, { recursive: true });
        const found = bridge.discoverAgentwrightCli(cwd);
        assert.equal(found, cli);
      } finally {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('returns null when neither config path nor bootstrap finds it', () => {
      const cwd = tmpDir();
      const empty = tmpDir();
      try {
        process.env.CLAUDE_PLUGIN_ROOT = empty;
        assert.equal(bridge.discoverAgentwrightCli(cwd), null);
      } finally {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe('readAgentwrightVersion', () => {
    test('reads version from sibling plugin.json', () => {
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        assert.equal(bridge.readAgentwrightVersion(cli), '2.1.5');
      } finally {
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('returns null when plugin.json is missing', () => {
      const stubRoot = tmpDir();
      try {
        const fakeCli = path.join(stubRoot, 'no-plugin-json', 'coordinator', 'index.js');
        fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
        fs.writeFileSync(fakeCli, '', 'utf8');
        assert.equal(bridge.readAgentwrightVersion(fakeCli), null);
      } finally {
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('returns null when sibling plugin.json identifies as a non-agentwright plugin', () => {
      // Security regression: forgewright must not surface an "agentwrightCli"
      // path to the leader unless the file is part of an actual agentwright
      // plugin layout. Otherwise a malicious .claude/forgewright.json could
      // redirect the leader's `node <agentwrightCli> cleanup-snapshot` shell
      // call to attacker code.
      const stubRoot = tmpDir();
      try {
        const evilCoordDir = path.join(stubRoot, 'evil', 'coordinator');
        const evilPluginMeta = path.join(stubRoot, 'evil', '.claude-plugin');
        fs.mkdirSync(evilCoordDir, { recursive: true });
        fs.mkdirSync(evilPluginMeta, { recursive: true });
        const evilCli = path.join(evilCoordDir, 'index.js');
        fs.writeFileSync(evilCli, '/* malicious */', 'utf8');
        // Attacker dropped a fake plugin.json — but it's NOT agentwright.
        fs.writeFileSync(path.join(evilPluginMeta, 'plugin.json'),
          JSON.stringify({ name: 'totally-not-agentwright', version: '999.0.0' }), 'utf8');
        assert.equal(bridge.readAgentwrightVersion(evilCli), null);
      } finally {
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });
  });

  describe('requireAgentwright', () => {
    test('passes when version meets pin', () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({ agentwright: { path: cli } }), 'utf8');
        const result = bridge.requireAgentwright(cwd);
        assert.equal(result.cli, cli);
        assert.equal(result.version, '2.1.5');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('rejects below minimum version', () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.4');
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({ agentwright: { path: cli } }), 'utf8');
        assert.throws(() => bridge.requireAgentwright(cwd),
          /forgewright requires agentwright >= 2\.1\.5; found 2\.1\.4/);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('throws with install instruction when CLI not found', () => {
      const cwd = tmpDir();
      const empty = tmpDir();
      try {
        process.env.CLAUDE_PLUGIN_ROOT = empty;
        assert.throws(() => bridge.requireAgentwright(cwd),
          /agentwright CLI not found/);
      } finally {
        delete process.env.CLAUDE_PLUGIN_ROOT;
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    test('auto-rebinds when bootstrap finds a strictly newer version than the stored path', () => {
      const cwd = tmpDir();
      const cacheRoot = tmpDir();
      try {
        // Versioned cache layout with two versions side-by-side.
        const oldDir = path.join(cacheRoot, 'agentwright', '2.1.5');
        const newDir = path.join(cacheRoot, 'agentwright', '2.1.6');
        for (const [dir, version] of [[oldDir, '2.1.5'], [newDir, '2.1.6']]) {
          fs.mkdirSync(path.join(dir, 'coordinator'), { recursive: true });
          fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'coordinator', 'index.js'), '', 'utf8');
          fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
            JSON.stringify({ name: 'agentwright', version }), 'utf8');
        }
        const oldCli = path.join(oldDir, 'coordinator', 'index.js');
        const newCli = path.join(newDir, 'coordinator', 'index.js');
        process.env.CLAUDE_PLUGIN_ROOT = path.join(cacheRoot, 'forgewright');
        fs.mkdirSync(process.env.CLAUDE_PLUGIN_ROOT, { recursive: true });

        // Stored = old; bootstrap finds new.
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({
            workflows: { custom: { phases: [{ name: 'echo', type: 'command', command: 'echo' }] } },
            agentwright: { path: oldCli },
          }), 'utf8');

        const result = bridge.requireAgentwright(cwd);
        assert.equal(result.cli, newCli);
        assert.equal(result.version, '2.1.6');

        // Persist: stored path updated. Custom workflow untouched.
        const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'forgewright.json'), 'utf8'));
        assert.equal(cfg.agentwright.path, newCli);
        assert.ok(cfg.workflows.custom, 'persist must be surgical — other config keys untouched');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(cacheRoot, { recursive: true, force: true });
      }
    });

    test('does not rebind when stored version equals bootstrap version (no churn)', () => {
      const cwd = tmpDir();
      const cacheRoot = tmpDir();
      try {
        const dir = path.join(cacheRoot, 'agentwright', '2.1.5');
        fs.mkdirSync(path.join(dir, 'coordinator'), { recursive: true });
        fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'coordinator', 'index.js'), '', 'utf8');
        fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'agentwright', version: '2.1.5' }), 'utf8');
        const cli = path.join(dir, 'coordinator', 'index.js');
        process.env.CLAUDE_PLUGIN_ROOT = path.join(cacheRoot, 'forgewright');
        fs.mkdirSync(process.env.CLAUDE_PLUGIN_ROOT, { recursive: true });

        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({ agentwright: { path: cli } }), 'utf8');
        const before = fs.statSync(path.join(cwd, '.claude', 'forgewright.json')).mtimeMs;

        const result = bridge.requireAgentwright(cwd);
        assert.equal(result.cli, cli);
        const after = fs.statSync(path.join(cwd, '.claude', 'forgewright.json')).mtimeMs;
        assert.equal(after, before, 'config file should not be rewritten when nothing changed');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(cacheRoot, { recursive: true, force: true });
      }
    });

    test('throws the install-instruction error when semver fails to load', () => {
      // Mirrors the workflow-ledger requireLockfile missing-dep test pattern.
      // Stage a valid stub on disk first, then reload the bridge with semver
      // intercepted so its private `semver = null` fallback kicks in.
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      try {
        const cli = writeStubAgentwright(stubRoot, '2.1.5');
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({ agentwright: { path: cli } }), 'utf8');

        const Module = require('node:module');
        const bridgePath = require.resolve('../../coordinator/agentwright-bridge');
        const origLoad = Module._load;
        delete require.cache[bridgePath];
        Module._load = function (request, ...rest) {
          if (request === 'semver') {
            const err = new Error('Cannot find module semver');
            err.code = 'MODULE_NOT_FOUND';
            throw err;
          }
          return origLoad.call(this, request, ...rest);
        };

        try {
          const fresh = require('../../coordinator/agentwright-bridge');
          assert.throws(
            () => fresh.requireAgentwright(cwd),
            err => /forgewright requires the "semver" npm package/.test(err.message)
              && /npm install/.test(err.message),
          );
        } finally {
          Module._load = origLoad;
          delete require.cache[bridgePath];
          // Force the next test to re-load the real (working) bridge.
          require('../../coordinator/agentwright-bridge');
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
      }
    });

    test('user-pinned non-cache install wins over bootstrap on ties (and lower bootstrap versions)', () => {
      const cwd = tmpDir();
      const stubRoot = tmpDir();
      const cacheRoot = tmpDir();
      try {
        // User pointed at a dev install at version 2.1.5.
        const devCli = writeStubAgentwright(stubRoot, '2.1.5');
        // Cache has a stale 2.1.5 too — same version, different path.
        const cacheDir = path.join(cacheRoot, 'agentwright', '2.1.5');
        fs.mkdirSync(path.join(cacheDir, 'coordinator'), { recursive: true });
        fs.mkdirSync(path.join(cacheDir, '.claude-plugin'), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'coordinator', 'index.js'), '', 'utf8');
        fs.writeFileSync(path.join(cacheDir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'agentwright', version: '2.1.5' }), 'utf8');
        process.env.CLAUDE_PLUGIN_ROOT = path.join(cacheRoot, 'forgewright');
        fs.mkdirSync(process.env.CLAUDE_PLUGIN_ROOT, { recursive: true });

        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
          JSON.stringify({ agentwright: { path: devCli } }), 'utf8');

        const result = bridge.requireAgentwright(cwd);
        assert.equal(result.cli, devCli, 'user pin must survive a tie');

        const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'forgewright.json'), 'utf8'));
        assert.equal(cfg.agentwright.path, devCli);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(stubRoot, { recursive: true, force: true });
        fs.rmSync(cacheRoot, { recursive: true, force: true });
      }
    });
  });
});
