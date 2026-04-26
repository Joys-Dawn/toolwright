'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const onStop = require('../hooks/on-stop');
const store = require('../lib/log-store');
const transcript = require('../lib/transcript');
const {
  userEvent,
  slashCommandEvent,
  toolResultEvent,
  assistantEvent,
} = require('./_helpers');

function writeTranscript(dir, name, events) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function makeStdin(payload) {
  return JSON.stringify(payload);
}

describe('on-stop hook', () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-onstop-'));
    logFile = path.join(tmpDir, 'log.ndjson');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op when last real user turn is not a wtf invocation', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess1', [
      userEvent('regular prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'a regular response' }], 't2'),
    ]);
    const orig = { session_id: 'sess1', wtf_response_marker: 'unchanged' };
    store.appendRecord(orig, { logFile });

    const code = await onStop.main({
      stdin: makeStdin({ session_id: 'sess1', transcript_path: transcriptFile }),
      logFile,
    });

    assert.equal(code, 0);
    const records = store.readAllRecords({ logFile });
    assert.equal(records.length, 1);
    assert.ok(!('wtf_response' in records[0]));
  });

  it('backfills wtf_response after wtf invocation', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess2', [
      userEvent('original prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'original assistant turn' }], 't2'),
      slashCommandEvent('gripewright:wtf', '', 't3'),
      assistantEvent([
        { type: 'thinking', thinking: 'reflecting...' },
        { type: 'text', text: 'Logged wtf to ...' },
      ], 't4'),
    ]);
    store.appendRecord({ session_id: 'sess2', some: 'record' }, { logFile });

    const code = await onStop.main({
      stdin: makeStdin({ session_id: 'sess2', transcript_path: transcriptFile }),
      logFile,
    });

    assert.equal(code, 0);
    const rec = store.readAllRecords({ logFile })[0];
    assert.ok(Array.isArray(rec.wtf_response));
    assert.equal(rec.wtf_response.length, 2);
    assert.equal(rec.wtf_response[0].type, 'thinking');
    assert.equal(rec.wtf_response[0].text, 'reflecting...');
    assert.equal(rec.wtf_response[1].type, 'text');
    assert.equal(rec.wtf_response[1].text, 'Logged wtf to ...');
  });

  it('no-op when log file missing', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess3', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'response' }], 't2'),
    ]);

    const code = await onStop.main({
      stdin: makeStdin({ session_id: 'sess3', transcript_path: transcriptFile }),
      logFile,
    });

    assert.equal(code, 0);
    assert.equal(fs.existsSync(logFile), false);
  });

  it('no-op when no matching session record', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess-a', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'response' }], 't2'),
    ]);
    store.appendRecord({ session_id: 'different-session' }, { logFile });

    const code = await onStop.main({
      stdin: makeStdin({ session_id: 'sess-a', transcript_path: transcriptFile }),
      logFile,
    });

    assert.equal(code, 0);
    const rec = store.readAllRecords({ logFile })[0];
    assert.ok(!('wtf_response' in rec));
  });

  it('skips record already backfilled (idempotency)', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess4', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'second response' }], 't2'),
    ]);
    store.appendRecord(
      { session_id: 'sess4', wtf_response: [{ type: 'text', text: 'first response', timestamp: 'old' }] },
      { logFile }
    );

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess4', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.equal(rec.wtf_response[0].text, 'first response');
  });

  it('multiple wtfs each get their response', async () => {
    // Real Claude Code transcripts grow append-only — by the time /wtf #2's
    // Stop fires, the transcript still contains /wtf #1 and its response.
    // Pairing pending record N with the N-th /wtf event (not "most recent")
    // is what keeps chained gripes correct.
    const events1 = [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'first response' }], 't2'),
    ];
    const transcriptFile = writeTranscript(tmpDir, 'sess5', events1);
    store.appendRecord({ session_id: 'sess5', n: 1 }, { logFile });

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess5', transcript_path: transcriptFile }),
      logFile,
    });

    const events2 = [
      ...events1,
      slashCommandEvent('gripewright:wtf', '', 't3'),
      assistantEvent([{ type: 'text', text: 'second response' }], 't4'),
    ];
    const transcriptFile2 = writeTranscript(tmpDir, 'sess5', events2);
    store.appendRecord({ session_id: 'sess5', n: 2 }, { logFile });

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess5', transcript_path: transcriptFile2 }),
      logFile,
    });

    const records = store.readAllRecords({ logFile });
    assert.equal(records.length, 2);
    assert.equal(records[0].wtf_response[0].text, 'first response');
    assert.equal(records[1].wtf_response[0].text, 'second response');
  });

  it('handles missing transcript file silently', async () => {
    store.appendRecord({ session_id: 'sess6' }, { logFile });

    const code = await onStop.main({
      stdin: makeStdin({ session_id: 'sess6', transcript_path: path.join(tmpDir, 'does-not-exist.jsonl') }),
      logFile,
    });

    assert.equal(code, 0);
    assert.ok(!('wtf_response' in store.readAllRecords({ logFile })[0]));
  });

  it('handles invalid stdin payload silently', async () => {
    store.appendRecord({ session_id: 'sess7' }, { logFile });

    assert.equal(await onStop.main({ stdin: 'not json', logFile }), 0);
    assert.equal(await onStop.main({ stdin: '', logFile }), 0);
    assert.equal(await onStop.main({ stdin: '{}', logFile }), 0);
  });

  it('atomic rewrite preserves other records byte-identical', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess8', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'response' }], 't2'),
    ]);
    const r1 = { session_id: 'other', n: 1 };
    const r2 = { session_id: 'sess8', n: 2 };
    const r3 = { session_id: 'other', n: 3 };
    store.appendRecord(r1, { logFile });
    store.appendRecord(r2, { logFile });
    store.appendRecord(r3, { logFile });

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess8', transcript_path: transcriptFile }),
      logFile,
    });

    const records = store.readAllRecords({ logFile });
    assert.equal(records.length, 3);
    assert.deepEqual(records[0], r1);
    assert.deepEqual(records[2], r3);
    assert.ok('wtf_response' in records[1]);
  });

  it('captures tool_use blocks and tool_result events from response', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess9', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([
        { type: 'tool_use', name: 'Bash', input: { command: 'cat log.ndjson' } },
      ], 't2'),
      toolResultEvent('record contents', 't3'),
      assistantEvent([{ type: 'text', text: 'Logged wtf' }], 't4'),
    ]);
    store.appendRecord({ session_id: 'sess9' }, { logFile });

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess9', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.equal(rec.wtf_response.length, 3);
    assert.equal(rec.wtf_response[0].type, 'tool_use');
    assert.equal(rec.wtf_response[1].type, 'tool_result');
    assert.equal(rec.wtf_response[1].content, 'record contents');
    assert.equal(rec.wtf_response[2].type, 'text');
  });

  it('only acts when most recent real user message is the wtf', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess10', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'wtf response' }], 't2'),
      userEvent('a follow-up prompt', 't3'),
      assistantEvent([{ type: 'text', text: 'follow-up response' }], 't4'),
    ]);
    store.appendRecord({ session_id: 'sess10' }, { logFile });

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess10', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.ok(!('wtf_response' in rec));
  });

  it('writes empty wtf_response if no assistant blocks after wtf', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess11', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
    ]);
    store.appendRecord({ session_id: 'sess11' }, { logFile });

    await onStop.main({
      stdin: makeStdin({ session_id: 'sess11', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.deepEqual(rec.wtf_response, []);
  });

  describe('stderr diagnostics', () => {
    function captureStderr(t) {
      const writes = [];
      t.mock.method(process.stderr, 'write', (chunk) => {
        writes.push(String(chunk));
        return true;
      });
      return writes;
    }

    it('logs and exits 0 when readTranscript throws', async (t) => {
      const transcriptFile = writeTranscript(tmpDir, 'diag1', [
        slashCommandEvent('gripewright:wtf', '', 't1'),
        assistantEvent([{ type: 'text', text: 'r' }], 't2'),
      ]);
      store.appendRecord({ session_id: 'diag1' }, { logFile });
      const writes = captureStderr(t);
      t.mock.method(transcript, 'readTranscript', () => { throw new Error('boom-read'); });

      const code = await onStop.main({
        stdin: makeStdin({ session_id: 'diag1', transcript_path: transcriptFile }),
        logFile,
      });

      assert.equal(code, 0);
      const out = writes.join('');
      assert.match(out, /\[gripewright\/on-stop\] read transcript failed:/);
      assert.match(out, /boom-read/);
      const rec = store.readAllRecords({ logFile })[0];
      assert.ok(!('wtf_response' in rec));
    });

    it('logs and exits 0 when readAllRecords throws', async (t) => {
      const transcriptFile = writeTranscript(tmpDir, 'diag2', [
        slashCommandEvent('gripewright:wtf', '', 't1'),
        assistantEvent([{ type: 'text', text: 'r' }], 't2'),
      ]);
      store.appendRecord({ session_id: 'diag2' }, { logFile });
      const writes = captureStderr(t);
      t.mock.method(store, 'readAllRecords', () => { throw new Error('boom-readlog'); });

      const code = await onStop.main({
        stdin: makeStdin({ session_id: 'diag2', transcript_path: transcriptFile }),
        logFile,
      });

      assert.equal(code, 0);
      const out = writes.join('');
      assert.match(out, /\[gripewright\/on-stop\] read log failed:/);
      assert.match(out, /boom-readlog/);
    });

    it('logs and exits 0 when rewriteAllRecords throws', async (t) => {
      const transcriptFile = writeTranscript(tmpDir, 'diag3', [
        slashCommandEvent('gripewright:wtf', '', 't1'),
        assistantEvent([{ type: 'text', text: 'r' }], 't2'),
      ]);
      store.appendRecord({ session_id: 'diag3' }, { logFile });
      const writes = captureStderr(t);
      t.mock.method(store, 'rewriteAllRecords', () => { throw new Error('boom-rewrite'); });

      const code = await onStop.main({
        stdin: makeStdin({ session_id: 'diag3', transcript_path: transcriptFile }),
        logFile,
      });

      assert.equal(code, 0);
      const out = writes.join('');
      assert.match(out, /\[gripewright\/on-stop\] rewrite log failed:/);
      assert.match(out, /boom-rewrite/);
    });
  });
});
