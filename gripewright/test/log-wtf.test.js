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

  it('lookback=1 anchors on most recent prompt', () => {
    const events = [
      userEvent('first prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a1' }], 't2'),
      userEvent('second prompt', 't3'),
      assistantEvent([{ type: 'text', text: 'a2' }], 't4'),
      slashCommandEvent('gripewright:wtf', '', 't5'),
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
      slashCommandEvent('gripewright:wtf', '', 't7'),
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
      slashCommandEvent('gripewright:wtf', '', 't3'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', '10'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.equal(rec.lookback_requested, 10);
    assert.equal(rec.lookback_effective, 1);
    assert.equal(rec.prior_user_prompt.text, 'only');
  });

  it('prior wtf invocation can serve as anchor (chained wtfs)', () => {
    const events = [
      userEvent('first prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a1' }], 't2'),
      slashCommandEvent('gripewright:wtf', 'lazy', 't3'),
      assistantEvent([{ type: 'text', text: 'logged + reflection' }], 't4'),
      slashCommandEvent('gripewright:wtf', 'flip-flop', 't5'),
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
      slashCommandEvent('gripewright:wtf', '', 't5'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.match(rec.prior_user_prompt.text, /agentwright:critique/);
  });

  it('no real prompt before wtf errors out', () => {
    const events = [
      slashCommandEvent('gripewright:wtf', '', 't1'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 1);
  });

  it('lookback zero errors out', () => {
    const events = [
      userEvent('p', 't1'),
      slashCommandEvent('gripewright:wtf', '', 't2'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', '0'], { home: tmpHome, logFile }), 1);
  });

  it('missing session errors out', () => {
    assert.equal(logWtf.main(['no-such-sid'], { home: tmpHome, logFile }), 1);
  });

  it('record_session_id falls back to CLI arg', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: 'p' }, timestamp: 't1' },
      slashCommandEvent('gripewright:wtf', '', 't2'),
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
      slashCommandEvent('gripewright:wtf', '', 't4'),
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
      slashCommandEvent('gripewright:wtf', '', 't5'),
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
      slashCommandEvent('gripewright:wtf', '', 't5'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    const rec = readLastRecord();
    assert.ok(!rec.turn_events.some(e => e.text && e.text.includes('system-reminder')));
    assert.ok(!rec.turn_events.some(e => e.text && e.text.includes('local-command-stdout')));
  });

  it('reason is persisted in record', () => {
    const events = [
      userEvent('p', 't1'),
      slashCommandEvent('gripewright:wtf', '', 't2'),
    ];
    writeSession(tmpHome, 'sid', events);

    assert.equal(logWtf.main(['sid', 'lazy', 'answer'], { home: tmpHome, logFile }), 0);
    assert.equal(readLastRecord().reason, 'lazy answer');
  });

  it('records appended not overwritten', () => {
    const events = [
      userEvent('p', 't1'),
      slashCommandEvent('gripewright:wtf', '', 't2'),
    ];
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
    const validWtf = JSON.stringify(slashCommandEvent('gripewright:wtf', '', 't2'));
    fs.writeFileSync(file, [validUser, 'not-json', validWtf, ''].join('\n'));

    assert.equal(logWtf.main(['sid'], { home: tmpHome, logFile }), 0);
    assert.equal(readLastRecord().prior_user_prompt.text, 'p');
  });
});
