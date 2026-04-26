'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const logWtf = require('../scripts/log-wtf');
const store = require('../lib/log-store');
const {
  userEvent,
  slashCommandEvent,
  toolResultEvent,
  assistantEvent,
  writeSession,
} = require('./_helpers');

describe('parseArgs', () => {
  it('no args returns no session', () => {
    assert.deepEqual(logWtf.parseArgs([]), { sessionId: null, lookback: 1, reason: null });
  });

  it('empty session returns no session', () => {
    assert.deepEqual(logWtf.parseArgs(['']), { sessionId: null, lookback: 1, reason: null });
  });

  it('whitespace session returns no session', () => {
    assert.deepEqual(logWtf.parseArgs(['  ']), { sessionId: null, lookback: 1, reason: null });
  });

  it('session only defaults to lookback 1, no reason', () => {
    assert.deepEqual(logWtf.parseArgs(['sid']), { sessionId: 'sid', lookback: 1, reason: null });
  });

  it('session plus reason', () => {
    assert.deepEqual(logWtf.parseArgs(['sid', 'lazy', 'answer']), {
      sessionId: 'sid', lookback: 1, reason: 'lazy answer',
    });
  });

  it('session plus lookback only', () => {
    assert.deepEqual(logWtf.parseArgs(['sid', '3']), { sessionId: 'sid', lookback: 3, reason: null });
  });

  it('session plus lookback plus reason', () => {
    assert.deepEqual(logWtf.parseArgs(['sid', '3', 'lazy', 'answer']), {
      sessionId: 'sid', lookback: 3, reason: 'lazy answer',
    });
  });

  it('lookback zero signals error (regression)', () => {
    const r = logWtf.parseArgs(['sid', '0', 'reason']);
    assert.equal(r.sessionId, 'sid');
    assert.equal(r.lookback, null);
  });

  it('multi-digit lookback parsed', () => {
    assert.equal(logWtf.parseArgs(['sid', '15']).lookback, 15);
  });

  it('negative number is not treated as lookback', () => {
    assert.deepEqual(logWtf.parseArgs(['sid', '-3', 'reason']), {
      sessionId: 'sid', lookback: 1, reason: '-3 reason',
    });
  });

  it('reason starting with digit is misread (known limitation)', () => {
    const r = logWtf.parseArgs(['sid', '5g answer']);
    assert.equal(r.lookback, 1);
    assert.equal(r.reason, '5g answer');
  });

  it('session id is stripped', () => {
    assert.equal(logWtf.parseArgs(['  sid  ']).sessionId, 'sid');
  });
});

describe('parseStdinInput', () => {
  it('empty string returns defaults', () => {
    assert.deepEqual(logWtf.parseStdinInput(''), { lookback: 1, reason: null });
  });

  it('whitespace-only stdin returns defaults', () => {
    assert.deepEqual(logWtf.parseStdinInput('   \n\n  \t '), { lookback: 1, reason: null });
  });

  it('bare positive integer parses as lookback with null reason', () => {
    assert.deepEqual(logWtf.parseStdinInput('3'), { lookback: 3, reason: null });
  });

  it('bare integer with trailing newline still parses as lookback only', () => {
    assert.deepEqual(logWtf.parseStdinInput('5\n'), { lookback: 5, reason: null });
  });

  it('integer followed by reason parses both', () => {
    assert.deepEqual(logWtf.parseStdinInput('2 lazy answer'), { lookback: 2, reason: 'lazy answer' });
  });

  it('multi-line reason preserves internal newlines verbatim', () => {
    assert.deepEqual(
      logWtf.parseStdinInput('5\nfoo\nbar'),
      { lookback: 5, reason: 'foo\nbar' }
    );
  });

  it('repeated internal whitespace is preserved', () => {
    assert.deepEqual(
      logWtf.parseStdinInput('hello   world'),
      { lookback: 1, reason: 'hello   world' }
    );
  });

  it('reason without leading integer defaults lookback to 1', () => {
    assert.deepEqual(
      logWtf.parseStdinInput('the model lied'),
      { lookback: 1, reason: 'the model lied' }
    );
  });

  it('lookback zero signals error', () => {
    assert.deepEqual(logWtf.parseStdinInput('0 anything'), { lookback: null, reason: null });
  });

  it('bare zero signals error', () => {
    assert.deepEqual(logWtf.parseStdinInput('0'), { lookback: null, reason: null });
  });

  it('reason starting with digit-letter is misread (matches parseArgs limitation)', () => {
    // Mirrors the documented limitation in parseArgs: a token like "5g" is not
    // a positive integer, so the whole text becomes the reason with lookback 1.
    assert.deepEqual(
      logWtf.parseStdinInput('5g answer'),
      { lookback: 1, reason: '5g answer' }
    );
  });

  it('negative number is not treated as lookback', () => {
    // The regex requires \d+ which doesn't match a leading minus.
    assert.deepEqual(
      logWtf.parseStdinInput('-3 reason'),
      { lookback: 1, reason: '-3 reason' }
    );
  });

  it('outer whitespace is trimmed but inner whitespace stays', () => {
    assert.deepEqual(
      logWtf.parseStdinInput('  \nhello\n\nworld\n  '),
      { lookback: 1, reason: 'hello\n\nworld' }
    );
  });

  it('shell-special chars pass through unchanged', () => {
    assert.deepEqual(
      logWtf.parseStdinInput("it's $broken `today`"),
      { lookback: 1, reason: "it's $broken `today`" }
    );
  });
});

describe('main lookback', () => {
  let tmpHome;
  let tmpLog;
  let logFile;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-main-home-'));
    tmpLog = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-main-log-'));
    logFile = path.join(tmpLog, 'log.ndjson');
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpLog, { recursive: true, force: true });
  });

  function readRecord(idx = 0) {
    return store.readAllRecords({ logFile })[idx];
  }

  function readLastRecord() {
    const all = store.readAllRecords({ logFile });
    return all[all.length - 1];
  }

  // Note: in production, the /gripewright:wtf event is NOT yet in the JSONL
  // when this script runs (it's part of `!`-preprocessing, which runs before
  // the harness persists the user message). Tests below mirror that reality:
  // the JSONL ends just before the wtf invocation.

  it('lookback=1 anchors on most recent prompt', () => {
    const events = [
      userEvent('first prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a1' }], 't2'),
      userEvent('second prompt', 't3'),
      assistantEvent([{ type: 'text', text: 'a2' }], 't4'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.equal(rec.prior_user_prompt.text, 'second prompt');
  });

  it('lookback=3 anchors on third prompt back', () => {
    const events = [
      userEvent('first', 't1'),
      assistantEvent([{ type: 'text', text: 'a1' }], 't2'),
      userEvent('second', 't3'),
      assistantEvent([{ type: 'text', text: 'a2' }], 't4'),
      userEvent('third', 't5'),
      assistantEvent([{ type: 'text', text: 'a3' }], 't6'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', '3'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.equal(rec.prior_user_prompt.text, 'first');
    assert.equal(rec.lookback_requested, 3);
    assert.equal(rec.lookback_effective, 3);
  });

  it('lookback clamped to available prompts', () => {
    const events = [
      userEvent('only', 't1'),
      assistantEvent([{ type: 'text', text: 'a' }], 't2'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', '10'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.equal(rec.lookback_requested, 10);
    assert.equal(rec.lookback_effective, 1);
    assert.equal(rec.prior_user_prompt.text, 'only');
  });

  it('prior wtf invocation can serve as anchor (chained wtfs)', () => {
    // The PRIOR /wtf has been written to the JSONL by the time the second /wtf
    // runs. The current /wtf (the one that triggered this script) is not.
    const events = [
      userEvent('first prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a1' }], 't2'),
      slashCommandEvent('gripewright:wtf', 'lazy', 't3'),
      assistantEvent([{ type: 'text', text: 'logged + reflection' }], 't4'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.match(rec.prior_user_prompt.text, /gripewright:wtf/);
    assert.match(rec.prior_user_prompt.text, /lazy/);
    assert.ok(rec.turn_events.some(e => e.type === 'text' && e.text.includes('logged + reflection')));
  });

  it('other slash commands kept as anchor', () => {
    const events = [
      userEvent('typed prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a1' }], 't2'),
      slashCommandEvent('agentwright:critique', 'design', 't3'),
      assistantEvent([{ type: 'text', text: 'a2' }], 't4'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.match(rec.prior_user_prompt.text, /agentwright:critique/);
  });

  it('slash-command-style first prompt anchors correctly (regression)', () => {
    // Single prior prompt that happens to be a slash command. Used to error
    // because the blind slice(0, -1) dropped this lone entry.
    const events = [
      slashCommandEvent('agentwright:correctness-audit', 'on the diff', 't1'),
      assistantEvent([{ type: 'text', text: 'working...' }], 't2'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.match(rec.prior_user_prompt.text, /agentwright:correctness-audit/);
  });

  it('no real prompt before wtf errors out', () => {
    writeSession(tmpHome, 'sid', []);
    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 1);
  });

  it('lookback zero errors out', () => {
    const events = [userEvent('p', 't1')];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', '0'], { home: tmpHome, logFile }), 1);
  });

  it('missing session errors out', () => {
    assert.equal(logWtf.main(['no-such-sid'], { home: tmpHome, logFile }), 1);
  });

  it('record_session_id falls back to CLI arg', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: 'p' }, timestamp: 't1' },
    ];
    writeSession(tmpHome, 'cli-sid', events);

    assert.equal(logWtf.main(['cli-sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.equal(rec.session_id, 'cli-sid');
  });

  it('interrupt marker does not anchor and is captured as user_followup (regression)', () => {
    const events = [
      userEvent('prompt', 't1'),
      assistantEvent([{ type: 'thinking', thinking: 'thinking...' }], 't2'),
      userEvent('[Request interrupted by user]', 't3'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.equal(rec.prior_user_prompt.text, 'prompt');
    assert.ok(rec.turn_events.some(e => e.type === 'user_followup' && e.text.includes('[Request interrupted by user]')));
  });

  it('tool_result captured in turn', () => {
    const events = [
      userEvent('prompt', 't1'),
      assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], 't2'),
      toolResultEvent('file1\nfile2', 't3'),
      assistantEvent([{ type: 'text', text: 'done' }], 't4'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    const tr = rec.turn_events.find(e => e.type === 'tool_result');
    assert.ok(tr);
    assert.equal(tr.content, 'file1\nfile2');
  });

  it('synthetic user messages in turn are ignored', () => {
    const events = [
      userEvent('prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a' }], 't2'),
      userEvent('<system-reminder>injected</system-reminder>', 't3'),
      userEvent('<local-command-stdout>script</local-command-stdout>', 't4'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.ok(!rec.turn_events.some(e => e.text && e.text.includes('system-reminder')));
    assert.ok(!rec.turn_events.some(e => e.text && e.text.includes('local-command-stdout')));
  });

  it('reason is persisted in record', () => {
    const events = [userEvent('p', 't1')];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', 'lazy', 'answer'], { home: tmpHome, logFile }), 0);
    assert.equal(readLastRecord().reason, 'lazy answer');
  });

  it('records appended not overwritten', () => {
    const events = [userEvent('p', 't1')];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', 'first'], { home: tmpHome, logFile }), 0);
    assert.equal(logWtf.main(['sid', 'second'], { home: tmpHome, logFile }), 0);
    const all = store.readAllRecords({ logFile });
    assert.equal(all.length, 2);
    assert.equal(all[0].reason, 'first');
    assert.equal(all[1].reason, 'second');
  });

  it('malformed jsonl lines skipped', () => {
    const projectDir = path.join(tmpHome, '.claude', 'projects', 'fake');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, 'sid.jsonl');
    const validUser = JSON.stringify(userEvent('p', 't1'));
    fs.writeFileSync(file, [validUser, 'not-json', ''].join('\n'));

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    assert.equal(readLastRecord().prior_user_prompt.text, 'p');
  });

  it('reason from stdin (heredoc path) preserves shell-special chars', () => {
    // Production passes user $ARGUMENTS via heredoc on stdin so apostrophes,
    // dollars, backticks etc. don't break shell parsing.
    const events = [userEvent('please refactor', 't1')];
    writeSession(tmpHome, 'sid', events);

    const stdin = "it's $broken `today`\n";
    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin }), 0);
    assert.equal(readLastRecord().reason, "it's $broken `today`");
  });

  it('lookback parsed from stdin', () => {
    const events = [
      userEvent('first', 't1'),
      assistantEvent([{ type: 'text', text: 'a' }], 't2'),
      userEvent('second', 't3'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin: '2 boring\n' }), 0);
    const rec = readLastRecord();
    assert.equal(rec.lookback_effective, 2);
    assert.equal(rec.prior_user_prompt.text, 'first');
    assert.equal(rec.reason, 'boring');
  });

  it('empty stdin treated as no extra args', () => {
    const events = [userEvent('p', 't1')];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin: '' }), 0);
    const rec = readLastRecord();
    assert.equal(rec.lookback_effective, 1);
    assert.equal(rec.reason, null);
  });

  it('stdin reason preserves newlines and repeated whitespace verbatim', () => {
    // Users may paste multi-line gripes; round-tripping through whitespace
    // tokenization would silently flatten them.
    const events = [userEvent('p', 't1')];
    writeSession(tmpHome, 'sid', events);

    const stdin = 'you claimed X\n\nbut Y is true\n  with   gaps\n';
    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin }), 0);
    assert.equal(readLastRecord().reason, 'you claimed X\n\nbut Y is true\n  with   gaps');
  });

  it('stdin lookback prefix is stripped without flattening the rest', () => {
    const events = [
      userEvent('first', 't1'),
      userEvent('second', 't2'),
      userEvent('third', 't3'),
    ];
    writeSession(tmpHome, 'sid', events);

    const stdin = '2 line one\nline two';
    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin }), 0);
    const rec = readLastRecord();
    assert.equal(rec.lookback_effective, 2);
    assert.equal(rec.reason, 'line one\nline two');
  });

  it('stdin with bare number sets lookback and null reason', () => {
    const events = [
      userEvent('first', 't1'),
      userEvent('second', 't2'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin: '2\n' }), 0);
    const rec = readLastRecord();
    assert.equal(rec.lookback_effective, 2);
    assert.equal(rec.reason, null);
  });

  it('stdin with lookback zero errors out', () => {
    const events = [userEvent('p', 't1')];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile, stdin: '0 some reason' }), 1);
  });
});
