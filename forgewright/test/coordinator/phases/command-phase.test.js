'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commandPhase = require('../../../coordinator/phases/command-phase');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cmd-'));
}

function writeConfig(cwd, content) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forgewright.json'), JSON.stringify(content, null, 2), 'utf8');
}

const SAMPLE_WORKFLOW = { workflowId: 'wf-1' };

describe('command-phase', () => {
  test('TYPE constant exposed', () => {
    assert.equal(commandPhase.TYPE, 'command');
    assert.equal(commandPhase.TEST_CMD_PLACEHOLDER, '${TEST_CMD}');
  });

  describe('buildDescriptor', () => {
    test('uses explicit command verbatim', () => {
      const cwd = tmpDir();
      try {
        const phase = { index: 0, name: 'cmd', type: 'command', command: 'pytest -q' };
        const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
        assert.equal(d.command, 'pytest -q');
        assert.equal(d.isPlaceholder, false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('substitutes ${TEST_CMD} from the workflow\'s frozen tests.command', () => {
      const cwd = tmpDir();
      try {
        const phase = { index: 0, name: 'cmd', type: 'command', command: '${TEST_CMD}' };
        const workflow = { workflowId: 'wf-1', tests: { command: 'npm test' } };
        const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
        assert.equal(d.command, 'npm test');
        assert.equal(d.isPlaceholder, false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('keeps ${TEST_CMD} placeholder when workflow.tests.command is null', () => {
      const cwd = tmpDir();
      try {
        const phase = { index: 0, name: 'cmd', type: 'command', command: '${TEST_CMD}' };
        const workflow = { workflowId: 'wf-1', tests: { command: null } };
        const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
        assert.equal(d.command, '${TEST_CMD}');
        assert.equal(d.isPlaceholder, true);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('ignores any on-disk forgewright.json — workflow.tests.command is the only source', () => {
      const cwd = tmpDir();
      try {
        // Disk config says `npm test`. The workflow has no frozen tests.command
        // (older workflow created before per-workflow tests existed, or user
        // simply hadn't set tests.command at workflow start). The disk value
        // must NOT leak in — that would silently violate the "frozen at start"
        // promise. Result: placeholder branch fires.
        writeConfig(cwd, { tests: { command: 'npm test' } });
        const phase = { index: 0, name: 'cmd', type: 'command', command: '${TEST_CMD}' };
        const workflow = { workflowId: 'wf-1' };
        const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
        assert.equal(d.command, '${TEST_CMD}');
        assert.equal(d.isPlaceholder, true);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('throws when command field is missing', () => {
      const cwd = tmpDir();
      try {
        assert.throws(() => commandPhase.buildDescriptor({ name: 'cmd', index: 0, type: 'command' }, SAMPLE_WORKFLOW, { cwd }),
          /requires a "command"/);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('appends phase.instruction overlay verbatim into the rendered instruction', () => {
      const cwd = tmpDir();
      try {
        const customText = 'Compare backtest Sharpe ratio to baseline; if v2 beats baseline by >0.05 advance with summary.decision="accept", else "reject".';
        const phase = {
          index: 0, name: 'cmd', type: 'command',
          command: 'python backtest.py --strategy=v2',
          instruction: customText,
        };
        const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
        assert.equal(d.command, 'python backtest.py --strategy=v2');
        // Behavior: phase.instruction text appears verbatim in d.instruction.
        // Surrounding template wording is presentation, not contract.
        assert.ok(d.instruction.includes(customText), 'overlay must be embedded verbatim');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('appends phase.instruction overlay even when the command is a ${TEST_CMD} placeholder', () => {
      const cwd = tmpDir();
      try {
        const customText = 'If only flaky tests fail, retry once before reporting.';
        const phase = {
          index: 0, name: 'cmd', type: 'command',
          command: '${TEST_CMD}',
          instruction: customText,
        };
        const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
        assert.equal(d.isPlaceholder, true);
        assert.ok(d.instruction.includes(customText), 'overlay must survive the placeholder branch');
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('blank or whitespace-only phase.instruction is treated as no overlay', () => {
      const cwd = tmpDir();
      try {
        // Behavior: a whitespace-only overlay does NOT alter d.instruction
        // relative to omitting the field — guards against injecting an empty
        // "phase-specific" section into the leader's prompt.
        const base = { index: 0, name: 'cmd', type: 'command', command: 'pytest -q' };
        const dNone = commandPhase.buildDescriptor(base, SAMPLE_WORKFLOW, { cwd });
        const dBlank = commandPhase.buildDescriptor({ ...base, instruction: '   ' }, SAMPLE_WORKFLOW, { cwd });
        assert.equal(dBlank.instruction, dNone.instruction);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    describe('${ARTIFACTS} substitution + produces auto-registration', () => {
      test('substitutes ${ARTIFACTS} with the project-relative artifacts dir', () => {
        const cwd = tmpDir();
        try {
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'python script.py --out-dir ${ARTIFACTS}',
          };
          const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
          assert.match(d.command, /^python script\.py --out-dir \.claude\/forgewright\/workflows\/wf-1\/artifacts$/);
          assert.doesNotMatch(d.command, /\$\{ARTIFACTS\}/);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('single produces with extension: descriptor exposes the resolved file path', () => {
        const cwd = tmpDir();
        try {
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'python eval.py --out-dir ${ARTIFACTS}',
            produces: 'metrics.json',
          };
          const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
          const expected = '.claude/forgewright/workflows/wf-1/artifacts/metrics.json';
          assert.equal(d.artifactPath, expected);
          assert.deepEqual(d.produces, [{ stem: 'metrics', filename: 'metrics.json', path: expected }]);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('single produces without extension: descriptor leaves the path open (--artifact-path required)', () => {
        const cwd = tmpDir();
        try {
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'python eval.py --out-dir ${ARTIFACTS}',
            produces: 'metrics',
          };
          const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
          // Behavior: bare produces leaves both artifactPath null and produces
          // empty so workflow-lifecycle requires --artifact-path from the leader
          // (enforced by validateResult; covered below).
          assert.equal(d.artifactPath, null);
          assert.deepEqual(d.produces, []);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('multi produces: descriptor lists each entry with its resolved path', () => {
        const cwd = tmpDir();
        try {
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'python train.py --output-dir ${ARTIFACTS}',
            produces: { metrics: 'metrics.json', model: 'model.bin', log: 'train.log' },
          };
          const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
          const base = '.claude/forgewright/workflows/wf-1/artifacts';
          // Command only substitutes ${ARTIFACTS}; the script writes filenames itself.
          assert.equal(d.command, `python train.py --output-dir ${base}`);
          // artifactPath is null for multi-output (no single canonical path).
          assert.equal(d.artifactPath, null);
          assert.equal(d.produces.length, 3);
          assert.deepEqual(d.produces.find(p => p.stem === 'metrics'),
            { stem: 'metrics', filename: 'metrics.json', path: `${base}/metrics.json` });
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

    });

    describe('consumes + ${ARTIFACT.<stem>} substitution', () => {
      function makeWorkflowWithArtifact(cwd, workflowId, stem, filename, body = '{}') {
        const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', workflowId);
        const artDir = path.join(wfDir, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        fs.writeFileSync(path.join(artDir, filename), body, 'utf8');
        return {
          workflowId,
          artifacts: { [stem]: `artifacts/${filename}` },
        };
      }

      test('${ARTIFACT.<stem>} substitutes to a project-relative registered path', () => {
        const cwd = tmpDir();
        try {
          const workflow = makeWorkflowWithArtifact(cwd, 'wf-1', 'model', 'model.bin', 'BIN');
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'python predict.py --model ${ARTIFACT.model}',
          };
          const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
          assert.equal(
            d.command,
            'python predict.py --model .claude/forgewright/workflows/wf-1/artifacts/model.bin',
          );
          assert.doesNotMatch(d.command, /\$\{ARTIFACT/);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('${ARTIFACT.<stem>} throws when the stem is not registered', () => {
        const cwd = tmpDir();
        try {
          const workflow = { workflowId: 'wf-1', artifacts: {} };
          const phase = {
            index: 2, name: 'cmd', type: 'command',
            command: 'python predict.py --model ${ARTIFACT.model}',
          };
          assert.throws(
            () => commandPhase.buildDescriptor(phase, workflow, { cwd }),
            /Command phase 2: artifact "model" was never recorded/,
          );
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('${ARTIFACT.<stem>} throws when the registered file is missing on disk', () => {
        const cwd = tmpDir();
        try {
          // Registered, but no file created.
          const workflow = {
            workflowId: 'wf-1',
            artifacts: { model: 'artifacts/model.bin' },
          };
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: '${ARTIFACT.model}',
          };
          assert.throws(
            () => commandPhase.buildDescriptor(phase, workflow, { cwd }),
            /missing on disk/,
          );
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('${ARTIFACT.<stem>} substitutes the same stem multiple times', () => {
        const cwd = tmpDir();
        try {
          const workflow = makeWorkflowWithArtifact(cwd, 'wf-1', 'model', 'model.bin');
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'diff ${ARTIFACT.model} ${ARTIFACT.model}',
          };
          const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
          const expected = '.claude/forgewright/workflows/wf-1/artifacts/model.bin';
          assert.equal(d.command, `diff ${expected} ${expected}`);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('consumes: string form validates and surfaces resolved paths', () => {
        const cwd = tmpDir();
        try {
          const workflow = makeWorkflowWithArtifact(cwd, 'wf-1', 'plan', 'plan.md', '# plan');
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'echo done',
            consumes: 'plan',
          };
          const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
          assert.deepEqual(d.consumes, [
            { stem: 'plan', path: '.claude/forgewright/workflows/wf-1/artifacts/plan.md' },
          ]);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('consumes: array form validates every stem', () => {
        const cwd = tmpDir();
        try {
          // Two registered artifacts on disk.
          const wfDir = path.join(cwd, '.claude', 'forgewright', 'workflows', 'wf-1', 'artifacts');
          fs.mkdirSync(wfDir, { recursive: true });
          fs.writeFileSync(path.join(wfDir, 'plan.md'), '#', 'utf8');
          fs.writeFileSync(path.join(wfDir, 'model.bin'), 'BIN', 'utf8');
          const workflow = {
            workflowId: 'wf-1',
            artifacts: { plan: 'artifacts/plan.md', model: 'artifacts/model.bin' },
          };
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'python eval.py --plan ${ARTIFACT.plan} --model ${ARTIFACT.model}',
            consumes: ['plan', 'model'],
          };
          const d = commandPhase.buildDescriptor(phase, workflow, { cwd });
          assert.equal(d.consumes.length, 2);
          assert.equal(d.consumes[0].stem, 'plan');
          assert.equal(d.consumes[1].stem, 'model');
          assert.match(d.command, /--plan \.claude\/forgewright\/workflows\/wf-1\/artifacts\/plan\.md/);
          assert.match(d.command, /--model \.claude\/forgewright\/workflows\/wf-1\/artifacts\/model\.bin/);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('consumes: unknown stem throws at descriptor-build time', () => {
        const cwd = tmpDir();
        try {
          const workflow = { workflowId: 'wf-1', artifacts: {} };
          const phase = {
            index: 3, name: 'cmd', type: 'command',
            command: 'echo done',
            consumes: ['missing-stem'],
          };
          assert.throws(
            () => commandPhase.buildDescriptor(phase, workflow, { cwd }),
            /Command phase 3: artifact "missing-stem" was never recorded/,
          );
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('consumes: rejects non-string entries in array form', () => {
        const cwd = tmpDir();
        try {
          const workflow = { workflowId: 'wf-1', artifacts: {} };
          const phase = {
            index: 1, name: 'cmd', type: 'command',
            command: 'echo done',
            consumes: ['plan', 42],
          };
          assert.throws(
            () => commandPhase.buildDescriptor(phase, workflow, { cwd }),
            /"consumes" array entry must be a non-empty string/i,
          );
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('consumes: rejects shape other than string or array', () => {
        const cwd = tmpDir();
        try {
          const workflow = { workflowId: 'wf-1', artifacts: {} };
          const phase = {
            index: 0, name: 'cmd', type: 'command',
            command: 'echo done',
            consumes: { plan: 'plan.md' },
          };
          assert.throws(
            () => commandPhase.buildDescriptor(phase, workflow, { cwd }),
            /"consumes" must be a string or an array of strings/,
          );
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });

      test('descriptor.consumes is an empty array when no consumes declared', () => {
        const cwd = tmpDir();
        try {
          const phase = { index: 0, name: 'cmd', type: 'command', command: 'pytest -q' };
          const d = commandPhase.buildDescriptor(phase, SAMPLE_WORKFLOW, { cwd });
          assert.deepEqual(d.consumes, []);
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });
    });
  });

  describe('resolveCommand (unit)', () => {
    test('returns explicit command verbatim with isPlaceholder=false', () => {
      const { command, isPlaceholder } = commandPhase.resolveCommand(
        { index: 0, command: 'pytest -q' }, { workflowId: 'wf-1' });
      assert.equal(command, 'pytest -q');
      assert.equal(isPlaceholder, false);
    });

    test('substitutes ${TEST_CMD} from workflow.tests.command', () => {
      const { command, isPlaceholder } = commandPhase.resolveCommand(
        { index: 0, command: '${TEST_CMD}' },
        { workflowId: 'wf-1', tests: { command: 'npm test' } });
      assert.equal(command, 'npm test');
      assert.equal(isPlaceholder, false);
    });

    test('falls back to placeholder when no tests.command configured', () => {
      const { command, isPlaceholder } = commandPhase.resolveCommand(
        { index: 0, command: '${TEST_CMD}' }, { workflowId: 'wf-1' });
      assert.equal(command, '${TEST_CMD}');
      assert.equal(isPlaceholder, true);
    });

    test('throws when phase.command is missing / empty / non-string', () => {
      for (const bad of [undefined, null, '', 42, {}]) {
        assert.throws(
          () => commandPhase.resolveCommand({ index: 4, command: bad }, { workflowId: 'wf-1' }),
          /requires a "command" string/,
        );
      }
    });
  });

  describe('validateResult', () => {
    test('accepts the wrapped { mcpResult } shape advanceWorkflow always passes', () => {
      assert.doesNotThrow(() =>
        commandPhase.validateResult({ mcpResult: { command: 'npm test', exitCode: 0, summary: 'ok' } }, {})
      );
    });

    test('rejects a payload missing command', () => {
      assert.throws(
        () => commandPhase.validateResult({ mcpResult: { exitCode: 0 } }, {}),
        /command must be a non-empty string/
      );
    });

    test('rejects a payload missing exitCode', () => {
      assert.throws(
        () => commandPhase.validateResult({ mcpResult: { command: 'npm test' } }, {}),
        /exitCode must be a number/
      );
    });

    test('rejects a non-object result', () => {
      assert.throws(() => commandPhase.validateResult(null, {}), /must be an object/);
    });

    test('bare-form produces requires --artifact-path (command picks filename)', () => {
      // Bare form "metrics" — no extension. The command picks the filename
      // at write time, so workflow-lifecycle.js cannot auto-register without
      // a leader-supplied path. Mirrors skill-phase semantics.
      const phase = { index: 4, type: 'command', produces: 'metrics' };
      assert.throws(
        () => commandPhase.validateResult(
          { mcpResult: { command: 'python eval.py', exitCode: 0, summary: 'ok' } },
          phase,
        ),
        /Command phase 4 declares produces:"metrics" — --artifact-path is required/,
      );
    });

    test('bare-form produces with artifactPath passes', () => {
      const phase = { index: 0, type: 'command', produces: 'metrics' };
      assert.doesNotThrow(() => commandPhase.validateResult(
        { artifactPath: 'artifacts/metrics.json', mcpResult: { command: 'x', exitCode: 0, summary: 'ok' } },
        phase,
      ));
    });

    test('extension-form produces does NOT require --artifact-path (auto-registered)', () => {
      // Single + extension is auto-registered by workflow-lifecycle.js:171-178
      // from the produces config alone — no leader-supplied path needed.
      const phase = { index: 0, type: 'command', produces: 'metrics.json' };
      assert.doesNotThrow(() => commandPhase.validateResult(
        { mcpResult: { command: 'python eval.py', exitCode: 0, summary: 'ok' } },
        phase,
      ));
    });

    test('multi-form produces does NOT require --artifact-path (all entries auto-registered)', () => {
      const phase = { index: 0, type: 'command', produces: { metrics: 'metrics.json', model: 'model.bin' } };
      assert.doesNotThrow(() => commandPhase.validateResult(
        { mcpResult: { command: 'python train.py', exitCode: 0, summary: 'ok' } },
        phase,
      ));
    });
  });
});
