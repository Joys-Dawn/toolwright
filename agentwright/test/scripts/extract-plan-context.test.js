'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT = path.resolve(__dirname, '../../scripts/extract-plan-context.js');
const {
  parseArgs,
  shortenInput,
  resolveWindow,
  buildReportAndTrace,
  truncateReportBody,
  extractUserText
} = require('../../scripts/extract-plan-context');

const REPORT_MAX_BYTES = 200 * 1024;

// ---- Pure-function tests --------------------------------------------------

describe('parseArgs', () => {
  it('parses sessionId and --plan-path with space', () => {
    const args = parseArgs(['abc-123', '--plan-path', '/tmp/p.md']);
    assert.deepEqual(args, { sessionId: 'abc-123', planPath: '/tmp/p.md' });
  });

  it('parses --plan-path=value form', () => {
    const args = parseArgs(['abc', '--plan-path=/tmp/p.md']);
    assert.deepEqual(args, { sessionId: 'abc', planPath: '/tmp/p.md' });
  });

  it('returns nulls for empty argv', () => {
    assert.deepEqual(parseArgs([]), { sessionId: null, planPath: null });
  });

  it('ignores unknown flags but still picks up sessionId', () => {
    const args = parseArgs(['--weird', 'sess-x']);
    assert.equal(args.sessionId, 'sess-x');
  });

  it('leaves planPath null when --plan-path has no following value', () => {
    const args = parseArgs(['sess-y', '--plan-path']);
    assert.equal(args.sessionId, 'sess-y');
    assert.equal(args.planPath, null);
  });
});

describe('shortenInput', () => {
  it('JSON-stringifies short inputs', () => {
    assert.equal(shortenInput({ a: 1 }), '{"a":1}');
  });

  it('truncates long inputs with ellipsis marker', () => {
    const big = { p: 'x'.repeat(500) };
    const out = shortenInput(big, 50);
    assert.ok(out.endsWith('…[truncated]'));
    assert.ok(out.length <= 50 + '…[truncated]'.length);
  });

  it('collapses whitespace in inputs', () => {
    assert.equal(shortenInput({ a: 'one\n\ntwo' }), '{"a":"one\\n\\ntwo"}');
  });

  it('falls back to String() when JSON.stringify throws on a circular ref', () => {
    const circular = { name: 'cycle' };
    circular.self = circular;

    const out = shortenInput(circular);

    assert.equal(out, '[object Object]');
  });
});

describe('resolveWindow', () => {
  function makeAttachment(uuid) {
    return { uuid, type: 'attachment', attachment: { type: 'plan_mode', planFilePath: '/p.md' } };
  }
  function makeExit(uuid) {
    return {
      uuid, type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `tu-${uuid}`, name: 'ExitPlanMode', input: {} }] }
    };
  }
  function makeAssistantText(uuid, text) {
    return { uuid, type: 'assistant', message: { content: [{ type: 'text', text }] } };
  }

  it('returns ExitPlanMode index when it follows the plan attachment, endIndex = events.length', () => {
    const events = [
      makeAttachment('att-1'),
      makeExit('exit-1'),
      makeAssistantText('a-1', 'doing work')
    ];
    const result = resolveWindow(events, events[0]);
    assert.equal(result.startIndex, 1);
    assert.equal(result.degradedStart, false);
    assert.equal(result.endIndex, events.length);
  });

  it('marks degradedStart when ExitPlanMode predates the plan attachment', () => {
    const events = [
      makeExit('exit-old'),
      makeAttachment('att-1'),
      makeAssistantText('a-1', 'doing work')
    ];
    const result = resolveWindow(events, events[1]);
    assert.equal(result.degradedStart, true);
    assert.equal(result.startIndex, 1);
  });

  it('marks degradedStart when no ExitPlanMode exists', () => {
    const events = [
      makeAttachment('att-1'),
      makeAssistantText('a-1', 'doing work')
    ];
    const result = resolveWindow(events, events[0]);
    assert.equal(result.degradedStart, true);
    assert.equal(result.startIndex, 0);
  });

  it('uses the latest of multiple plan-mode sessions', () => {
    const events = [
      makeAttachment('att-1'),
      makeExit('exit-1'),
      makeAssistantText('a-1', 'first impl'),
      makeAttachment('att-2'),
      makeExit('exit-2'),
      makeAssistantText('a-2', 'second impl')
    ];
    // Caller passes the latest attachment (mimicking findLastPlanAttachment).
    const result = resolveWindow(events, events[3]);
    assert.equal(result.startIndex, 4); // exit-2
    assert.equal(result.degradedStart, false);
    assert.equal(result.endIndex, events.length);
  });

  it('handles --plan-path mode (null attachment) with most recent ExitPlanMode', () => {
    const events = [
      makeExit('exit-1'),
      makeAssistantText('a-1', 'doing work')
    ];
    const result = resolveWindow(events, null);
    assert.equal(result.startIndex, 0);
    assert.equal(result.degradedStart, false);
  });

  it('handles --plan-path mode with no ExitPlanMode at all', () => {
    const events = [
      makeAssistantText('a-1', 'doing work')
    ];
    const result = resolveWindow(events, null);
    assert.equal(result.startIndex, -1);
  });
});

describe('buildReportAndTrace', () => {
  it('extracts text, thinking, and tool_use blocks within the window', () => {
    const events = [
      { uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu0', name: 'ExitPlanMode', input: {} }] } },
      { uuid: 'a1', type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'Doing step 1' },
        { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.js' } }
      ]}},
      // tool_result for tu1
      { uuid: 'r1', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'edited', is_error: false }] } },
      { uuid: 'end', type: 'user', message: { content: [{ type: 'text', text: 'verify-plan' }] } }
    ];
    const { reportSegments, traceLines } = buildReportAndTrace(events, 0, 3);
    assert.equal(reportSegments.length, 2);
    assert.ok(reportSegments[0].includes('plan'));
    assert.ok(reportSegments[0].startsWith('<thinking>'));
    assert.equal(reportSegments[1], 'Doing step 1');
    assert.equal(traceLines.length, 1);
    assert.ok(traceLines[0].includes('Edit'));
    assert.ok(traceLines[0].endsWith('\tok'));
  });

  it('marks fail status when tool_result has is_error', () => {
    const events = [
      { uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tuS', name: 'ExitPlanMode', input: {} }] } },
      { uuid: 'a1', type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'false' } }
      ]}},
      { uuid: 'r1', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true }] } }
    ];
    const { traceLines } = buildReportAndTrace(events, 0, events.length);
    assert.equal(traceLines.length, 1);
    assert.ok(traceLines[0].endsWith('\tfail'));
  });

  it('marks pending status when tool_result is missing', () => {
    const events = [
      { uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tuS', name: 'ExitPlanMode', input: {} }] } },
      { uuid: 'a1', type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.js' } }
      ]}}
    ];
    const { traceLines } = buildReportAndTrace(events, 0, events.length);
    assert.ok(traceLines[0].endsWith('\tpending'));
  });

  it('returns empty arrays when window is empty', () => {
    const { reportSegments, traceLines } = buildReportAndTrace([], 0, 0);
    assert.deepEqual(reportSegments, []);
    assert.deepEqual(traceLines, []);
  });

  it('skips empty text and thinking blocks', () => {
    const events = [
      { uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu0', name: 'ExitPlanMode', input: {} }] } },
      { uuid: 'a1', type: 'assistant', message: { content: [
        { type: 'text', text: '' },
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'real content' }
      ]}}
    ];

    const { reportSegments } = buildReportAndTrace(events, 0, events.length);

    assert.deepEqual(reportSegments, ['real content']);
  });

  it('includes real user text wrapped in <user> blocks so the verifier sees mid-implementation directives', () => {
    const events = [
      { uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu0', name: 'ExitPlanMode', input: {} }] } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'starting work' }] } },
      { uuid: 'u1', type: 'user', message: { content: [{ type: 'text', text: 'actually skip step 4' }] } },
      { uuid: 'a2', type: 'assistant', message: { content: [{ type: 'text', text: 'ok skipping step 4' }] } },
      { uuid: 'u2', type: 'user', message: { content: '<command-name>/agentwright:verify-plan</command-name>\n<command-args>but ignore the skip</command-args>' } }
    ];

    const { reportSegments } = buildReportAndTrace(events, 0, events.length);

    assert.deepEqual(reportSegments, [
      'starting work',
      '<user>\nactually skip step 4\n</user>',
      'ok skipping step 4',
      '<user>\n<command-name>/agentwright:verify-plan</command-name>\n<command-args>but ignore the skip</command-args>\n</user>'
    ]);
  });

  it('skips tool_result and injected wrapper blocks while still including real user text in the same event', () => {
    const events = [
      { uuid: 'start', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu0', name: 'ExitPlanMode', input: {} }] } },
      {
        uuid: 'mixed',
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-edit', content: 'edited' },
            { type: 'text', text: '<system-reminder>noise</system-reminder>' },
            { type: 'text', text: 'real follow-up from user' }
          ]
        }
      }
    ];

    const { reportSegments } = buildReportAndTrace(events, 0, events.length);

    assert.deepEqual(reportSegments, ['<user>\nreal follow-up from user\n</user>']);
  });
});

describe('extractUserText', () => {
  it('returns string content as-is (trimmed)', () => {
    const event = { type: 'user', message: { content: '  hello world  ' } };
    assert.equal(extractUserText(event), 'hello world');
  });

  it('joins text blocks from array content', () => {
    const event = {
      type: 'user',
      message: { content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' }
      ]}
    };
    assert.equal(extractUserText(event), 'one\ntwo');
  });

  it('returns null for tool_result-only content', () => {
    const event = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'edited' }] }
    };
    assert.equal(extractUserText(event), null);
  });

  it('strips system-reminder, local-command-stdout, local-command-stderr blocks', () => {
    const event = {
      type: 'user',
      message: { content: [
        { type: 'text', text: '<system-reminder>injected</system-reminder>' },
        { type: 'text', text: '<local-command-stdout>x</local-command-stdout>' },
        { type: 'text', text: '<local-command-stderr>y</local-command-stderr>' },
        { type: 'text', text: 'kept' }
      ]}
    };
    assert.equal(extractUserText(event), 'kept');
  });

  it('preserves slash-command invocations as user content (so verify-plan args reach the verifier)', () => {
    const raw = '<command-name>/agentwright:verify-plan</command-name>\n<command-args>focus on auth</command-args>';
    const event = { type: 'user', message: { content: raw } };

    const out = extractUserText(event);

    assert.equal(out, raw);
  });

  it('returns null for empty or malformed content', () => {
    assert.equal(extractUserText(null), null);
    assert.equal(extractUserText({}), null);
    assert.equal(extractUserText({ message: null }), null);
    assert.equal(extractUserText({ message: { content: '' } }), null);
    assert.equal(extractUserText({ message: { content: '   ' } }), null);
    assert.equal(extractUserText({ message: { content: [] } }), null);
  });
});

describe('truncateReportBody', () => {
  it('passes through bodies under the limit unchanged', () => {
    const body = 'short body\nwith multiple\nlines';

    const { body: out, truncated } = truncateReportBody(body);

    assert.equal(out, body);
    assert.equal(truncated, false);
  });

  it('keeps the tail and starts at a clean line boundary when truncating', () => {
    const lineCount = 30000;
    const lines = Array.from({ length: lineCount }, (_, i) => `line-${String(i).padStart(6, '0')}`);
    const body = lines.join('\n');

    const { body: out, truncated } = truncateReportBody(body);

    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(out, 'utf8') <= REPORT_MAX_BYTES);
    assert.ok(out.split('\n')[0].startsWith('line-'), 'first surviving line should be a complete record');
    assert.ok(out.endsWith(`line-${String(lineCount - 1).padStart(6, '0')}`), 'tail should be preserved');
  });

  it('does not produce U+FFFD replacement characters when the cut lands inside a multi-byte sequence', () => {
    // Build a body where a multi-byte CJK char straddles the truncation boundary.
    const filler = 'x'.repeat(REPORT_MAX_BYTES);
    const body = filler + '\n中文测试の絵文字🎉 final marker';

    const { body: out, truncated } = truncateReportBody(body);

    assert.equal(truncated, true);
    assert.ok(!out.includes('�'), 'truncated body must not contain UTF-8 replacement characters');
    assert.ok(out.endsWith('final marker'));
  });

  it('falls back to raw tail when no newline exists in the kept window', () => {
    // A single huge line with no \n inside the kept window — line-alignment is impossible.
    const body = 'A' + 'x'.repeat(REPORT_MAX_BYTES + 100);

    const { body: out, truncated } = truncateReportBody(body);

    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(out, 'utf8') <= REPORT_MAX_BYTES);
  });
});

// ---- End-to-end CLI tests -------------------------------------------------

function runScript({ sessionId, home, planPath } = {}) {
  const args = [SCRIPT];
  if (sessionId) args.push(sessionId);
  if (planPath) args.push('--plan-path', planPath);
  const env = { ...process.env };
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
    env.HOMEDRIVE = '';
    env.HOMEPATH = '';
  }
  const result = spawnSync('node', args, {
    encoding: 'utf8',
    timeout: 5000,
    env
  });
  return { exitCode: result.status, stdout: (result.stdout || '').trim(), stderr: result.stderr || '' };
}

function writeJsonl(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

describe('extract-plan-context CLI (end-to-end)', () => {
  let homeDir;
  let sessionsRoot;
  let planFile;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-e2e-'));
    sessionsRoot = path.join(homeDir, '.claude', 'projects', 'demo-project');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    planFile = path.join(homeDir, 'PLAN.md');
    fs.writeFileSync(planFile, '# Plan\n\n## Implementation Steps\n1. Do thing\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('happy path: writes plan.md, report.md, tool-trace.txt and prints the temp dir', () => {
    const sessionId = 'sess-happy';
    const events = [
      { uuid: 'a1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile, planExists: true } },
      {
        uuid: 'a2', type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-exit', name: 'ExitPlanMode', input: {} }] }
      },
      {
        uuid: 'a3', type: 'assistant',
        message: { content: [
          { type: 'text', text: 'Implementing step 1' },
          { type: 'tool_use', id: 'tu-edit-1', name: 'Edit', input: { file_path: 'src/foo.js' } }
        ]}
      },
      {
        uuid: 'a4', type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-edit-1', content: 'ok', is_error: false }] }
      },
      {
        uuid: 'a5', type: 'user',
        message: { content: [{ type: 'text', text: '<command-name>/agentwright:verify-plan</command-name>' }] }
      }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);

    const result = runScript({ sessionId, home: homeDir });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const tempDir = result.stdout;
    assert.ok(fs.existsSync(tempDir), 'temp dir should exist');
    assert.ok(fs.existsSync(path.join(tempDir, 'plan.md')));
    assert.ok(fs.existsSync(path.join(tempDir, 'report.md')));
    assert.ok(fs.existsSync(path.join(tempDir, 'tool-trace.txt')));

    const planContent = fs.readFileSync(path.join(tempDir, 'plan.md'), 'utf8');
    assert.ok(planContent.includes('## Implementation Steps'));

    const report = fs.readFileSync(path.join(tempDir, 'report.md'), 'utf8');
    assert.ok(report.includes('Implementing step 1'));
    assert.ok(!report.includes('WARNING: degraded'));
    assert.ok(report.includes('<user>'), 'user events should be wrapped in <user> blocks');
    assert.ok(report.includes('/agentwright:verify-plan'), 'verify-plan invocation should reach the report as the directive channel');

    const trace = fs.readFileSync(path.join(tempDir, 'tool-trace.txt'), 'utf8');
    assert.ok(trace.includes('Edit'));
    assert.ok(trace.includes('\tok'));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('errors when no plan attachment and no --plan-path', () => {
    const sessionId = 'sess-noplan';
    const events = [
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'no plan here' }] } }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);
    const result = runScript({ sessionId, home: homeDir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('No plan_mode attachment'), `unexpected stderr: ${result.stderr}`);
  });

  it('--plan-path overrides auto-detection even when attachment present', () => {
    const sessionId = 'sess-override';
    const otherPlan = path.join(homeDir, 'OTHER.md');
    fs.writeFileSync(otherPlan, '# Other Plan\n', 'utf8');
    const events = [
      { uuid: 'a1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } },
      { uuid: 'a2', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-exit', name: 'ExitPlanMode', input: {} }] } },
      { uuid: 'a3', type: 'assistant', message: { content: [{ type: 'text', text: 'work' }] } }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);

    const result = runScript({ sessionId, home: homeDir, planPath: otherPlan });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const planContent = fs.readFileSync(path.join(result.stdout, 'plan.md'), 'utf8');
    assert.ok(planContent.includes('Other Plan'));
    fs.rmSync(result.stdout, { recursive: true, force: true });
  });

  it('warns and degrades when ExitPlanMode is missing', () => {
    const sessionId = 'sess-noexit';
    const events = [
      { uuid: 'a1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } },
      { uuid: 'a2', type: 'assistant', message: { content: [{ type: 'text', text: 'jumping straight to work' }] } }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);

    const result = runScript({ sessionId, home: homeDir });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes('degraded'), `expected degraded warning; got: ${result.stderr}`);
    const report = fs.readFileSync(path.join(result.stdout, 'report.md'), 'utf8');
    assert.ok(report.includes('WARNING: degraded'));
    fs.rmSync(result.stdout, { recursive: true, force: true });
  });

  it('uses most recent of multiple plan attachments', () => {
    const sessionId = 'sess-multi';
    const planB = path.join(homeDir, 'PLAN_B.md');
    fs.writeFileSync(planB, '# Plan B\n', 'utf8');
    const events = [
      { uuid: '1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } },
      { uuid: '2', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'exitA', name: 'ExitPlanMode', input: {} }] } },
      { uuid: '3', type: 'assistant', message: { content: [{ type: 'text', text: 'first round' }] } },
      { uuid: '4', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planB } },
      { uuid: '5', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'exitB', name: 'ExitPlanMode', input: {} }] } },
      { uuid: '6', type: 'assistant', message: { content: [{ type: 'text', text: 'second round' }] } }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);

    const result = runScript({ sessionId, home: homeDir });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const planContent = fs.readFileSync(path.join(result.stdout, 'plan.md'), 'utf8');
    assert.ok(planContent.includes('Plan B'));
    const report = fs.readFileSync(path.join(result.stdout, 'report.md'), 'utf8');
    assert.ok(report.includes('second round'));
    assert.ok(!report.includes('first round'));
    fs.rmSync(result.stdout, { recursive: true, force: true });
  });

  it('errors when plan file no longer exists on disk', () => {
    const sessionId = 'sess-missing-plan';
    const events = [
      { uuid: 'a1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: '/nonexistent/PLAN.md' } }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);
    const result = runScript({ sessionId, home: homeDir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('Plan file does not exist'));
  });

  it('errors when session JSONL not found', () => {
    const result = runScript({ sessionId: 'definitely-not-a-real-session', home: homeDir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('Session transcript not found'));
  });

  it('errors when sessionId argument is missing', () => {
    const result = runScript({ home: homeDir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('Usage:'));
  });

  it('truncates report.md to last 200KB and emits a truncation warning header when the implementer narrative exceeds the limit', () => {
    const sessionId = 'sess-truncate';
    // Each text block is ~5KB; 60 blocks -> ~300KB report body, well above the 200KB cap.
    const blocks = Array.from({ length: 60 }, (_, i) => ({
      uuid: `a-${i}`,
      type: 'assistant',
      message: { content: [{ type: 'text', text: `BLOCK_${i} ` + 'x'.repeat(5000) }] }
    }));
    const events = [
      { uuid: 'att', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } },
      { uuid: 'exit', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-exit', name: 'ExitPlanMode', input: {} }] } },
      ...blocks
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);

    const result = runScript({ sessionId, home: homeDir });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);

    const reportPath = path.join(result.stdout, 'report.md');
    const report = fs.readFileSync(reportPath, 'utf8');
    const reportBytes = fs.statSync(reportPath).size;

    assert.ok(report.includes('# WARNING: report truncated to last 204800 bytes'));
    // The body itself is capped at 200KB; the file is body + a short header so total < 201KB.
    assert.ok(reportBytes < 200 * 1024 + 1024, `report file should be ~200KB + small header, got ${reportBytes}`);
    // Latest blocks should survive (truncation keeps the tail), oldest should not.
    assert.ok(report.includes('BLOCK_59'), 'most recent block should be retained');
    assert.ok(!report.includes('BLOCK_0 '), 'oldest block should be truncated away');

    fs.rmSync(result.stdout, { recursive: true, force: true });
  });

  it('--plan-path mode without a plan_mode attachment writes the NOTE header and warns about session-wide scope', () => {
    const sessionId = 'sess-handauthored';
    const handPlan = path.join(homeDir, 'HAND.md');
    fs.writeFileSync(handPlan, '# Hand-authored Plan\n', 'utf8');
    const events = [
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'doing some work' }] } }
    ];
    writeJsonl(path.join(sessionsRoot, `${sessionId}.jsonl`), events);

    const result = runScript({ sessionId, home: homeDir, planPath: handPlan });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('No plan-mode anchor found and --plan-path provided'),
      `expected session-wide-scope warning; got: ${result.stderr}`
    );
    const report = fs.readFileSync(path.join(result.stdout, 'report.md'), 'utf8');
    assert.ok(report.includes('# NOTE: --plan-path supplied'));
    assert.ok(report.includes('doing some work'), 'session-wide scope should include all assistant text');
    fs.rmSync(result.stdout, { recursive: true, force: true });
  });
});
