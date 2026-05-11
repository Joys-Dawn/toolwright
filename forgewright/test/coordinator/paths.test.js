'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateWorkflowId,
  validateWorkflowName,
  ensureWorkflowBase,
  workflowDir,
  workflowFile,
  artifactsDir,
  configFile,
} = require('../../coordinator/paths');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-paths-'));
}

describe('paths', () => {
  describe('validateWorkflowId', () => {
    test('accepts valid IDs', () => {
      assert.equal(validateWorkflowId('2026-04-28-feature-a1b2c3d4'), '2026-04-28-feature-a1b2c3d4');
      assert.equal(validateWorkflowId('A.b_c-d'), 'A.b_c-d');
    });

    test('rejects invalid IDs', () => {
      assert.throws(() => validateWorkflowId('-leading-dash'), /Invalid workflow ID/);
      assert.throws(() => validateWorkflowId('has spaces'), /Invalid workflow ID/);
      assert.throws(() => validateWorkflowId('has/slash'), /Invalid workflow ID/);
      assert.throws(() => validateWorkflowId(''), /Invalid workflow ID/);
      assert.throws(() => validateWorkflowId(null), /Invalid workflow ID/);
    });
  });

  describe('validateWorkflowName', () => {
    test('accepts valid names', () => {
      assert.equal(validateWorkflowName('feature'), 'feature');
      assert.equal(validateWorkflowName('bug-fix'), 'bug-fix');
      assert.equal(validateWorkflowName('My_Workflow1'), 'My_Workflow1');
    });

    test('rejects invalid names', () => {
      assert.throws(() => validateWorkflowName('1leading-digit'), /Invalid workflow name/);
      assert.throws(() => validateWorkflowName('has space'), /Invalid workflow name/);
      assert.throws(() => validateWorkflowName(''), /Invalid workflow name/);
    });
  });

  describe('ensureWorkflowBase', () => {
    test('creates the .claude/forgewright/workflows tree', () => {
      const cwd = tmpDir();
      try {
        const dir = ensureWorkflowBase(cwd);
        assert.ok(fs.existsSync(dir));
        assert.equal(dir, path.join(cwd, '.claude', 'forgewright', 'workflows'));
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('workflowDir / workflowFile / artifactsDir', () => {
    test('returns workflow-scoped paths', () => {
      const cwd = tmpDir();
      try {
        const id = '2026-04-28-feature-a1b2c3d4';
        const dir = workflowDir(cwd, id);
        const file = workflowFile(cwd, id);
        const artifacts = artifactsDir(cwd, id);
        assert.equal(dir, path.join(cwd, '.claude', 'forgewright', 'workflows', id));
        assert.equal(file, path.join(dir, 'workflow.json'));
        assert.equal(artifacts, path.join(dir, 'artifacts'));
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('configFile', () => {
    test('returns .claude/forgewright.json', () => {
      const cwd = tmpDir();
      try {
        assert.equal(configFile(cwd), path.join(cwd, '.claude', 'forgewright.json'));
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
