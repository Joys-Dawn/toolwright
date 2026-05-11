'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeStubAgentwright } = require('./agentwright-stub');

const CLI_PATH = path.resolve(__dirname, '..', '..', 'coordinator', 'index.js');

function tmpDir(prefix = 'fw-int-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeParseJson(s) {
  const trimmed = String(s || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
}

/**
 * Spawn the real forgewright CLI under `cwd` with the given args. Returns the
 * exit code, stdout, stderr, and a best-effort JSON parse of stdout. Tests
 * that need raw stdout can ignore `.json`; tests that need typed payloads
 * already have them parsed.
 *
 * @param {string} cwd - Project directory to invoke the CLI from.
 * @param {string[]} args - argv after the CLI path.
 * @param {Object} [extraEnv] - Optional env-var overrides (e.g. CLAUDE_PLUGIN_ROOT).
 * @returns {{ code: number|null, stdout: string, stderr: string, json: any }}
 */
function runCli(cwd, args, extraEnv = {}) {
  const proc = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return {
    code: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    json: safeParseJson(proc.stdout),
  };
}

/**
 * Stages a tmpdir as a project root with `.claude/forgewright.json` configured
 * to use the given workflow definition and a fresh stub agentwright CLI.
 * Returns the cwd plus a `cleanup` thunk the caller must call in `finally`.
 *
 * @param {Object} definition - Workflow definition (registered under `workflows.simple`).
 * @returns {{ cwd: string, cli: string, stubRoot: string, cleanup: () => void }}
 */
function setupRepo(definition) {
  const cwd = tmpDir();
  const stubRoot = tmpDir();
  const cli = writeStubAgentwright(stubRoot, { version: '2.1.5', runId: 'integration-run' });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'forgewright.json'),
    JSON.stringify({
      workflows: { simple: definition },
      agentwright: { path: cli },
    }, null, 2), 'utf8');
  return {
    cwd,
    cli,
    stubRoot,
    cleanup: () => {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(stubRoot, { recursive: true, force: true });
    },
  };
}

module.exports = { tmpDir, runCli, safeParseJson, setupRepo, CLI_PATH };
