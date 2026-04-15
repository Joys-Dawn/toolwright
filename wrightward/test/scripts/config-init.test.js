'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT = path.resolve(__dirname, '../../scripts/config-init.js');
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const EXAMPLE_PATH = path.join(PLUGIN_ROOT, 'wrightward.example.json');

function runScript({ projectDir, pluginRoot = PLUGIN_ROOT, args = [] } = {}) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: projectDir
    }
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

describe('wrightward config-init script', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wright-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes .claude/wrightward.json when no config exists', () => {
    const result = runScript({ projectDir });

    assert.equal(result.exitCode, 0);
    const target = path.join(projectDir, '.claude', 'wrightward.json');
    assert.ok(fs.existsSync(target), 'expected target file to exist');
  });

  it('creates .claude/ directory if missing', () => {
    assert.equal(fs.existsSync(path.join(projectDir, '.claude')), false);

    const result = runScript({ projectDir });

    assert.equal(result.exitCode, 0);
    assert.ok(fs.statSync(path.join(projectDir, '.claude')).isDirectory());
  });

  it('written content is byte-identical to the bundled example', () => {
    runScript({ projectDir });

    const written = fs.readFileSync(path.join(projectDir, '.claude', 'wrightward.json'), 'utf8');
    const expected = fs.readFileSync(EXAMPLE_PATH, 'utf8');
    assert.equal(written, expected);
  });

  it('refuses to overwrite existing file without --force', () => {
    const claudeDir = path.join(projectDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const target = path.join(claudeDir, 'wrightward.json');
    fs.writeFileSync(target, '{"custom":true}');

    const result = runScript({ projectDir });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /already exists/);
    assert.match(result.stderr, /--force/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"custom":true}');
  });

  it('overwrites existing file when --force is passed', () => {
    const claudeDir = path.join(projectDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const target = path.join(claudeDir, 'wrightward.json');
    fs.writeFileSync(target, '{"custom":true}');

    const result = runScript({ projectDir, args: ['--force'] });

    assert.equal(result.exitCode, 0);
    const written = fs.readFileSync(target, 'utf8');
    assert.notEqual(written, '{"custom":true}');
    assert.equal(written, fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  });

  it('exits non-zero when bundled example is missing', () => {
    const fakePluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wright-fake-plugin-'));

    const result = runScript({ projectDir, pluginRoot: fakePluginRoot });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /not found/);

    fs.rmSync(fakePluginRoot, { recursive: true, force: true });
  });

  it('exits with a clear error when .claude exists as a file', () => {
    fs.writeFileSync(path.join(projectDir, '.claude'), 'not a directory');

    const result = runScript({ projectDir });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /not a directory/);
  });
});
