'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const path = require('path');

const {
  requireClaudeCli,
  spawnAuditor,
  buildAllowedTools,
  createJsonLineReader,
  createTextDeltaLineReader
} = require('../../coordinator/process-manager');

describe('process-manager', () => {
  describe('module exports', () => {
    it('exports requireClaudeCli', () => {
      assert.equal(typeof requireClaudeCli, 'function');
    });

    it('exports spawnAuditor', () => {
      assert.equal(typeof spawnAuditor, 'function');
    });

    it('exports createJsonLineReader', () => {
      assert.equal(typeof createJsonLineReader, 'function');
    });

    it('exports createTextDeltaLineReader', () => {
      assert.equal(typeof createTextDeltaLineReader, 'function');
    });
  });

  describe('buildAllowedTools', () => {
    it('returns an array of tool strings', () => {
      const tools = buildAllowedTools();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
    });

    it('includes Read, Glob, Grep', () => {
      const tools = buildAllowedTools();
      assert.ok(tools.includes('Read'));
      assert.ok(tools.includes('Glob'));
      assert.ok(tools.includes('Grep'));
    });

    it('does not include LS', () => {
      const tools = buildAllowedTools();
      assert.ok(!tools.includes('LS'));
    });

    it('does not include Write or Edit (auditor is read-only)', () => {
      const tools = buildAllowedTools();
      assert.ok(!tools.includes('Write'));
      assert.ok(!tools.includes('Edit'));
    });

    it('includes scoped Bash tools', () => {
      const tools = buildAllowedTools();
      assert.ok(tools.some(t => t.startsWith('Bash(')));
    });
  });

  describe('createJsonLineReader', () => {
    function readableFrom(chunks) {
      const stream = new Readable({ read() {} });
      for (const chunk of chunks) {
        stream.push(Buffer.from(chunk, 'utf8'));
      }
      stream.push(null);
      return stream;
    }

    it('parses complete JSON lines', (_, done) => {
      const lines = [];
      const readable = readableFrom(['{"a":1}\n{"b":2}\n']);
      createJsonLineReader(readable, line => lines.push(line));
      readable.on('end', () => {
        assert.equal(lines.length, 2);
        assert.equal(lines[0], '{"a":1}');
        assert.equal(lines[1], '{"b":2}');
        done();
      });
    });

    it('handles lines split across chunks', (_, done) => {
      const lines = [];
      const readable = readableFrom(['{"a":', '1}\n']);
      createJsonLineReader(readable, line => lines.push(line));
      readable.on('end', () => {
        assert.equal(lines.length, 1);
        assert.equal(lines[0], '{"a":1}');
        done();
      });
    });

    it('skips blank lines', (_, done) => {
      const lines = [];
      const readable = readableFrom(['{"a":1}\n\n\n{"b":2}\n']);
      createJsonLineReader(readable, line => lines.push(line));
      readable.on('end', () => {
        assert.equal(lines.length, 2);
        done();
      });
    });

    it('flushes remaining buffer on end', (_, done) => {
      const lines = [];
      const readable = readableFrom(['{"no_newline":true}']);
      createJsonLineReader(readable, line => lines.push(line));
      readable.on('end', () => {
        assert.equal(lines.length, 1);
        assert.equal(lines[0], '{"no_newline":true}');
        done();
      });
    });
  });

  describe('createTextDeltaLineReader', () => {
    it('emits complete lines from handleDelta calls', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler('{"type":"finding"}\n');
      assert.equal(lines.length, 1);
      assert.equal(lines[0], '{"type":"finding"}');
    });

    it('buffers partial lines until newline', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler('{"type":');
      assert.equal(lines.length, 0);
      handler('"finding"}\n');
      assert.equal(lines.length, 1);
      assert.equal(lines[0], '{"type":"finding"}');
    });

    it('handles multiple lines in one call', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler('line1\nline2\nline3\n');
      assert.equal(lines.length, 3);
    });

    it('flush emits remaining buffer', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler('no newline at end');
      assert.equal(lines.length, 0);
      handler.flush();
      assert.equal(lines.length, 1);
      assert.equal(lines[0], 'no newline at end');
    });

    it('flush does nothing when buffer is empty', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler.flush();
      assert.equal(lines.length, 0);
    });

    it('flush does nothing when buffer is only whitespace', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler('   \n');
      handler.flush();
      assert.equal(lines.length, 0);
    });

    it('handles null/undefined input gracefully', () => {
      const lines = [];
      const handler = createTextDeltaLineReader(line => lines.push(line));
      handler(null);
      handler(undefined);
      handler('ok\n');
      assert.equal(lines.length, 1);
      // null and undefined are coerced to '' by String(text || '')
      assert.equal(lines[0], 'ok');
    });

    it('simulates a realistic text delta stream with findings', () => {
      const findings = [];
      const handler = createTextDeltaLineReader(line => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'finding' || parsed.type === 'done') {
            findings.push(parsed);
          }
        } catch (e) {
          // Skip non-JSON lines
        }
      });

      // Simulate chunked text deltas as they'd arrive from the LLM
      handler('{"type":"fin');
      handler('ding","finding":{"id":"sec-1","severity":"high","title":"SQL injection"}}\n');
      handler('{"type":"finding","finding":{"id":"sec-2","severity":"low","title":"Unused import"}}\n');
      handler('{"type":"done","auditType":"security","summary":"Found 2 issues","emittedCount":2}\n');

      assert.equal(findings.length, 3);
      assert.equal(findings[0].type, 'finding');
      assert.equal(findings[0].finding.id, 'sec-1');
      assert.equal(findings[1].finding.id, 'sec-2');
      assert.equal(findings[2].type, 'done');
      assert.equal(findings[2].emittedCount, 2);
    });
  });

  describe('stream-json event processing pipeline', () => {
    function readableFrom(chunks) {
      const stream = new Readable({ read() {} });
      for (const chunk of chunks) {
        stream.push(Buffer.from(chunk, 'utf8'));
      }
      stream.push(null);
      return stream;
    }

    it('parses findings and done marker from stream-json text_delta events', (_, done) => {
      const findings = [];
      let doneEvent = null;
      let resultEvent = null;

      const handleTextDelta = createTextDeltaLineReader(line => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'finding') findings.push(parsed);
          if (parsed.type === 'done') doneEvent = parsed;
        } catch (_) {}
      });

      const finding = JSON.stringify({
        type: 'finding',
        finding: { id: 'test-1', severity: 'high', title: 'Test bug', file: 'a.js', problem: 'p', fix: 'f' }
      });
      const doneMarker = JSON.stringify({
        type: 'done', auditType: 'correctness', summary: 'Found 1 issue.', emittedCount: 1
      });

      const events = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: finding + '\n' } } }) + '\n',
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: doneMarker + '\n' } } }) + '\n',
        JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'
      ];

      const readable = readableFrom(events);
      createJsonLineReader(readable, line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') resultEvent = event;
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
            handleTextDelta(event.event.delta.text);
          }
        } catch (_) {}
      });

      readable.on('end', () => {
        handleTextDelta.flush();
        assert.equal(findings.length, 1);
        assert.equal(findings[0].finding.id, 'test-1');
        assert.ok(doneEvent);
        assert.equal(doneEvent.emittedCount, 1);
        assert.ok(resultEvent);
        assert.equal(resultEvent.is_error, false);
        done();
      });
    });

    it('handles findings split across multiple text_delta chunks', (_, done) => {
      const findings = [];

      const handleTextDelta = createTextDeltaLineReader(line => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'finding') findings.push(parsed);
        } catch (_) {}
      });

      const part1 = '{"type":"finding","finding":{"id":"split-1"';
      const part2 = ',"severity":"low","title":"Split","file":"b.js","problem":"p","fix":"f"}}\n';

      const events = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part1 } } }) + '\n',
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part2 } } }) + '\n'
      ];

      const readable = readableFrom(events);
      createJsonLineReader(readable, line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
            handleTextDelta(event.event.delta.text);
          }
        } catch (_) {}
      });

      readable.on('end', () => {
        handleTextDelta.flush();
        assert.equal(findings.length, 1);
        assert.equal(findings[0].finding.id, 'split-1');
        done();
      });
    });

    it('handles result with is_error: true', (_, done) => {
      let resultEvent = null;
      let doneFromError = null;

      const events = [
        JSON.stringify({ type: 'result', is_error: true, result: 'Auditor crashed.' }) + '\n'
      ];

      const readable = readableFrom(events);
      createJsonLineReader(readable, line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            resultEvent = event;
            if (event.is_error) {
              doneFromError = { type: 'done', error: true, summary: String(event.result) };
            }
          }
        } catch (_) {}
      });

      readable.on('end', () => {
        assert.ok(resultEvent);
        assert.equal(resultEvent.is_error, true);
        assert.ok(doneFromError);
        assert.equal(doneFromError.error, true);
        assert.equal(doneFromError.summary, 'Auditor crashed.');
        done();
      });
    });
  });

  describe('requireClaudeCli', () => {
    it('does not throw when claude is available', () => {
      requireClaudeCli();
    });
  });

  describe('cross-turn buffer contamination', () => {
    const MOCK_CROSS_TURN = path.resolve(__dirname, 'fixtures/mock-auditor-cross-turn.js');

    function spawnCrossTurnMock(args = []) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MOCK_CROSS_TURN, ...args], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const findings = [];
        let doneEvent = null;
        let resultEvent = null;
        let sawTextDelta = false;

        const handleTextDelta = createTextDeltaLineReader(line => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'finding') findings.push(parsed);
            if (parsed.type === 'done') doneEvent = parsed;
          } catch (_) {}
        });

        createJsonLineReader(child.stdout, line => {
          try {
            const event = JSON.parse(line);
            if (event.type === 'result') resultEvent = event;
            if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event?.delta?.type === 'text_delta') {
              sawTextDelta = true;
              handleTextDelta(event.event.delta.text);
            }
            if (event.type === 'stream_event' && event.event?.type === 'content_block_stop') {
              handleTextDelta.flush();
            }
          } catch (_) {}
        });

        child.on('close', code => {
          handleTextDelta.flush();
          resolve({ exitCode: code, findings, doneEvent, resultEvent });
        });
        child.on('error', reject);
      });
    }

    it('detects done marker after prose in a separate content block', async () => {
      const { exitCode, findings, doneEvent } = await spawnCrossTurnMock();
      assert.equal(exitCode, 0);
      assert.equal(findings.length, 0);
      assert.ok(doneEvent, 'Done marker must be detected despite prose in prior content block');
      assert.equal(doneEvent.type, 'done');
      assert.equal(doneEvent.auditType, 'security');
      assert.equal(doneEvent.emittedCount, 0);
    });

    it('detects findings and done marker across separate content blocks', async () => {
      const { exitCode, findings, doneEvent } = await spawnCrossTurnMock(['--with-findings']);
      assert.equal(exitCode, 0);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].finding.id, 'cross-1');
      assert.ok(doneEvent, 'Done marker must be detected after findings in separate blocks');
      assert.equal(doneEvent.emittedCount, 1);
    });

    it('fails to detect done marker WITHOUT content_block_stop flush', async () => {
      // Prove the bug existed: process the same stream WITHOUT flushing on
      // content_block_stop, and show the done marker is lost.
      const child = spawn(process.execPath, [MOCK_CROSS_TURN], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const result = await new Promise((resolve, reject) => {
        let doneEvent = null;
        const handleTextDelta = createTextDeltaLineReader(line => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'done') doneEvent = parsed;
          } catch (_) {}
        });

        createJsonLineReader(child.stdout, line => {
          try {
            const event = JSON.parse(line);
            if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
              handleTextDelta(event.event.delta.text);
            }
            // Deliberately NOT flushing on content_block_stop
          } catch (_) {}
        });

        child.on('close', code => {
          handleTextDelta.flush();
          resolve({ exitCode: code, doneEvent });
        });
        child.on('error', reject);
      });

      assert.equal(result.exitCode, 0);
      // Without the flush fix, the prose contaminates the buffer and the
      // done marker gets concatenated with it, failing JSON.parse.
      assert.equal(result.doneEvent, null, 'Without flush fix, done marker should be lost');
    });
  });

  describe('mock-auditor integration', () => {
    const MOCK_AUDITOR = path.resolve(__dirname, 'fixtures/mock-auditor.js');

    function spawnMockAuditor(args = []) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MOCK_AUDITOR, ...args], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const findings = [];
        let doneEvent = null;
        let resultEvent = null;

        const handleTextDelta = createTextDeltaLineReader(line => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'finding') findings.push(parsed);
            if (parsed.type === 'done') doneEvent = parsed;
          } catch (_) {}
        });

        createJsonLineReader(child.stdout, line => {
          try {
            const event = JSON.parse(line);
            if (event.type === 'result') resultEvent = event;
            if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
              handleTextDelta(event.event.delta.text);
            }
          } catch (_) {}
        });

        child.on('close', code => {
          handleTextDelta.flush();
          resolve({ exitCode: code, findings, doneEvent, resultEvent });
        });
        child.on('error', reject);
      });
    }

    it('parses findings and done marker from mock auditor', async () => {
      const { exitCode, findings, doneEvent, resultEvent } = await spawnMockAuditor();
      assert.equal(exitCode, 0);
      assert.equal(findings.length, 2);
      assert.equal(findings[0].finding.id, 'mock-1');
      assert.equal(findings[1].finding.id, 'mock-2');
      assert.ok(doneEvent);
      assert.equal(doneEvent.emittedCount, 2);
      assert.ok(resultEvent);
      assert.equal(resultEvent.is_error, false);
    });

    it('handles auditor failure with is_error result', async () => {
      const { exitCode, findings, doneEvent, resultEvent } = await spawnMockAuditor(['--fail']);
      assert.equal(exitCode, 1);
      assert.equal(findings.length, 0);
      assert.equal(doneEvent, null);
      assert.ok(resultEvent);
      assert.equal(resultEvent.is_error, true);
    });

    it('handles auditor that omits done marker', async () => {
      const { exitCode, findings, doneEvent } = await spawnMockAuditor(['--no-done']);
      assert.equal(exitCode, 0);
      assert.equal(findings.length, 2);
      assert.equal(doneEvent, null);
    });
  });

  describe('mock-auditor-fused integration', () => {
    const MOCK_FUSED = path.resolve(__dirname, 'fixtures/mock-auditor-fused.js');

    function spawnMockFusedAuditor(args = []) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MOCK_FUSED, ...args], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const findings = [];
        let doneEvent = null;
        let resultEvent = null;

        const handleTextDelta = createTextDeltaLineReader(line => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'finding') findings.push(parsed);
            if (parsed.type === 'done') doneEvent = parsed;
          } catch (_) {}
        });

        createJsonLineReader(child.stdout, line => {
          try {
            const event = JSON.parse(line);
            if (event.type === 'result') resultEvent = event;
            if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
              handleTextDelta(event.event.delta.text);
            }
          } catch (_) {}
        });

        child.on('close', code => {
          handleTextDelta.flush();
          resolve({ exitCode: code, findings, doneEvent, resultEvent });
        });
        child.on('error', reject);
      });
    }

    it('preserves auditType on every finding from a fused auditor', async () => {
      const { exitCode, findings, doneEvent } = await spawnMockFusedAuditor();
      assert.equal(exitCode, 0);
      assert.equal(findings.length, 3);
      assert.equal(findings[0].finding.auditType, 'correctness-audit');
      assert.equal(findings[1].finding.auditType, 'security-audit');
      assert.equal(findings[2].finding.auditType, 'best-practices-audit');
      assert.ok(doneEvent);
      assert.equal(doneEvent.auditType, 'audit-bundle');
      assert.equal(doneEvent.emittedCount, 3);
    });

    it('passes through findings that omit auditType (graceful degradation)', async () => {
      const { exitCode, findings } = await spawnMockFusedAuditor(['--missing-type']);
      assert.equal(exitCode, 0);
      assert.equal(findings.length, 3);
      assert.equal(findings[0].finding.auditType, 'correctness-audit');
      assert.equal(findings[1].finding.auditType, undefined);
      assert.equal(findings[2].finding.auditType, 'best-practices-audit');
    });
  });
});
