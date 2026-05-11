'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  ContractError,
  validateCommandResult,
  validateHandoffBatchResult,
  validatePipelinePhaseResult,
} = require('../../coordinator/wrightward-contract');

describe('wrightward-contract', () => {
  describe('validateCommandResult', () => {
    test('accepts well-formed command result', () => {
      const out = validateCommandResult({ command: 'npm test', exitCode: 0, summary: 'ok' });
      assert.equal(out.command, 'npm test');
      assert.equal(out.exitCode, 0);
    });

    test('rejects missing exitCode', () => {
      assert.throws(() => validateCommandResult({ command: 'x' }), ContractError);
    });

    test('rejects non-object input', () => {
      assert.throws(() => validateCommandResult(null), /command result must be an object/);
      assert.throws(() => validateCommandResult('not-an-object'), /command result must be an object/);
      assert.throws(() => validateCommandResult([1, 2]), /command result must be an object/);
    });

    test('rejects empty command string', () => {
      assert.throws(() => validateCommandResult({ command: '', exitCode: 0 }), /command must be a non-empty string/);
    });

    test('rejects non-string command', () => {
      assert.throws(() => validateCommandResult({ command: 42, exitCode: 0 }), /command must be a non-empty string/);
    });

    test('defaults summary to empty string when caller supplies a non-string value', () => {
      const out = validateCommandResult({ command: 'npm test', exitCode: 0, summary: 99 });
      assert.equal(out.summary, '');
    });
  });

  describe('validateHandoffBatchResult', () => {
    test('accepts a batch with peer + self tasks', () => {
      const out = validateHandoffBatchResult({
        tasks: [
          { key: 'task-1', by: 'peer:bob-42', status: 'completed', ackId: 'ack-1' },
          { key: 'task-2', by: 'self', status: 'completed' },
          { key: 'task-3', by: 'peer:sam-17', status: 'failed', detail: 'no peer' },
        ],
      });
      assert.equal(out.tasks.length, 3);
    });

    test('rejects missing tasks array', () => {
      assert.throws(() => validateHandoffBatchResult({}), ContractError);
    });

    test('rejects malformed by field', () => {
      assert.throws(() => validateHandoffBatchResult({
        tasks: [{ key: 'x', by: 'unknown', status: 'completed' }],
      }), /by must be "self" or "peer:/);
    });

    test('rejects unknown task status', () => {
      assert.throws(() => validateHandoffBatchResult({
        tasks: [{ key: 'x', by: 'self', status: 'maybe' }],
      }), /status must be completed/);
    });
  });

  describe('validatePipelinePhaseResult', () => {
    test('accepts a well-formed delta payload from /agentwright:check-deltas', () => {
      const out = validatePipelinePhaseResult({
        ok: true,
        runId: 'run-1',
        groupIndex: 0,
        snapshotPath: '/tmp/snap',
        totalAdded: 5,
        totalDeleted: 2,
        totalDiffLines: 7,
        totalLoc: 100,
        ratio: 0.07,
        changedFiles: ['src/a.js', 'src/b.js'],
      });
      assert.equal(out.totalAdded, 5);
      assert.equal(out.totalDeleted, 2);
      assert.equal(out.ratio, 0.07);
      assert.deepEqual(out.changedFiles, ['src/a.js', 'src/b.js']);
    });

    test('rejects when count fields are not finite numbers', () => {
      assert.throws(() => validatePipelinePhaseResult({
        totalAdded: 'oops',
        totalDeleted: 0,
        totalDiffLines: 0,
        totalLoc: 0,
        ratio: 0,
        changedFiles: [],
      }), /totalAdded must be a finite number/);
    });

    test('rejects when ratio is NaN', () => {
      assert.throws(() => validatePipelinePhaseResult({
        totalAdded: 0,
        totalDeleted: 0,
        totalDiffLines: 0,
        totalLoc: 0,
        ratio: Number.NaN,
        changedFiles: [],
      }), /ratio must be a finite number/);
    });

    test('rejects when changedFiles is not an array', () => {
      assert.throws(() => validatePipelinePhaseResult({
        totalAdded: 0,
        totalDeleted: 0,
        totalDiffLines: 0,
        totalLoc: 0,
        ratio: 0,
        changedFiles: 'src/a.js',
      }), /changedFiles must be an array/);
    });

    test('rejects when a changedFiles entry is not a string', () => {
      assert.throws(() => validatePipelinePhaseResult({
        totalAdded: 0,
        totalDeleted: 0,
        totalDiffLines: 0,
        totalLoc: 0,
        ratio: 0,
        changedFiles: ['src/a.js', 42],
      }), /changedFiles\[1\] must be a string/);
    });
  });
});
