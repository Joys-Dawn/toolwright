'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const onUserPromptSubmit = require('../hooks/on-user-prompt-submit');
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

describe('on-user-prompt-submit hook', () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-onups-'));
    logFile = path.join(tmpDir, 'log.ndjson');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op when no log file exists', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess1', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'r' }], 't2'),
    ]);

    const code = await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess1', transcript_path: transcriptFile }),
      logFile,
    });

    assert.equal(code, 0);
    assert.equal(fs.existsSync(logFile), false);
  });

  it('no-op when log has no record for this session', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess2', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'r' }], 't2'),
    ]);
    store.appendRecord({ session_id: 'other-session' }, { logFile });

    const code = await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess2', transcript_path: transcriptFile }),
      logFile,
    });

    assert.equal(code, 0);
    const rec = store.readAllRecords({ logFile })[0];
    assert.ok(!('wtf_response' in rec));
  });

  it('no-op when session record is already backfilled', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess3', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'newer response' }], 't2'),
    ]);
    store.appendRecord(
      { session_id: 'sess3', wtf_response: [{ type: 'text', text: 'pre-existing', timestamp: 'old' }] },
      { logFile }
    );

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess3', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.equal(rec.wtf_response[0].text, 'pre-existing');
  });

  it('backfills when last assistant response was not interrupted (Stop happy-path fallback)', async () => {
    // Both Stop and UserPromptSubmit can fire — UserPromptSubmit acts as
    // a fallback for cases where Stop didn't capture (e.g. text-only
    // interrupt). It should still work cleanly when called on a happy-path
    // turn that Stop already missed somehow.
    const transcriptFile = writeTranscript(tmpDir, 'sess4', [
      slashCommandEvent('gripewright:wtf', 'why so lazy', 't1'),
      assistantEvent([
        { type: 'thinking', thinking: 'reflecting...' },
        { type: 'text', text: 'You raise a fair point.' },
      ], 't2'),
    ]);
    store.appendRecord({ session_id: 'sess4' }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess4', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.equal(rec.wtf_response.length, 2);
    assert.equal(rec.wtf_response[0].type, 'thinking');
    assert.equal(rec.wtf_response[1].type, 'text');
  });

  it('backfills text-only interrupt: captures partial blocks before next user prompt', async () => {
    // The user invoked /wtf, the model produced a partial reflection
    // ("You're right that —"), the user pressed Esc, then typed a new
    // prompt. UserPromptSubmit fires on the new prompt; transcript
    // already contains the new prompt as the latest event.
    const transcriptFile = writeTranscript(tmpDir, 'sess5', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: "You're right that —" }], 't2'),
      userEvent('actually nevermind, do something else', 't3'),
    ]);
    store.appendRecord({ session_id: 'sess5' }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess5', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.equal(rec.wtf_response.length, 1);
    assert.equal(rec.wtf_response[0].type, 'text');
    assert.equal(rec.wtf_response[0].text, "You're right that —");
  });

  it('backfills tool-call interrupt: captures tool_use + partial tool_result', async () => {
    // The model started a Bash call, the user interrupted before the
    // result came back. Then they typed a new prompt.
    const transcriptFile = writeTranscript(tmpDir, 'sess6', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([
        { type: 'tool_use', name: 'Bash', input: { command: 'sleep 60' } },
      ], 't2'),
      toolResultEvent('[Request interrupted by user]', 't3'),
      userEvent('try a different approach', 't4'),
    ]);
    store.appendRecord({ session_id: 'sess6' }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess6', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.equal(rec.wtf_response.length, 2);
    assert.equal(rec.wtf_response[0].type, 'tool_use');
    assert.equal(rec.wtf_response[1].type, 'tool_result');
    assert.match(rec.wtf_response[1].content, /interrupted/);
  });

  it('backfills empty array if user interrupts before any blocks were emitted', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess7', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      userEvent('ok wait do something else', 't2'),
    ]);
    store.appendRecord({ session_id: 'sess7' }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess7', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.deepEqual(rec.wtf_response, []);
  });

  it('only backfills the most recent pending record for this session', async () => {
    // /wtf #1 → response → backfilled (record A complete)
    // /wtf #2 → response interrupted (record B pending)
    // user types new prompt → UserPromptSubmit fires → backfill record B
    const transcriptFile = writeTranscript(tmpDir, 'sess8', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'first reflection' }], 't2'),
      slashCommandEvent('gripewright:wtf', 'still bad', 't3'),
      assistantEvent([{ type: 'text', text: 'second reflection (partial)' }], 't4'),
      userEvent('moving on', 't5'),
    ]);
    store.appendRecord(
      { session_id: 'sess8', n: 1, wtf_response: [{ type: 'text', text: 'first reflection', timestamp: 't2' }] },
      { logFile }
    );
    store.appendRecord({ session_id: 'sess8', n: 2 }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess8', transcript_path: transcriptFile }),
      logFile,
    });

    const records = store.readAllRecords({ logFile });
    assert.equal(records.length, 2);
    assert.equal(records[0].wtf_response[0].text, 'first reflection');
    assert.equal(records[1].wtf_response.length, 1);
    assert.equal(records[1].wtf_response[0].text, 'second reflection (partial)');
  });

  it('chained-interrupt regression: pairs pending record A with /wtf #1, not /wtf #2', async () => {
    // /wtf #1 → response interrupted, record A pending (hooks didn't capture
    //          before user pressed Esc and typed /wtf #2).
    // User types /wtf #2 → UserPromptSubmit fires BEFORE log-wtf.js runs for
    //                      /wtf #2, so only record A exists in the log.
    // Transcript already has /wtf #2 appended.
    //
    // The naive "pending record + most-recent /wtf" pairing (the pre-fix
    // behavior) collected blocks between /wtf #2 and end-of-transcript →
    // empty array → record A's partial response from /wtf #1 lost forever.
    //
    // Correct pairing: K-th pending record ↔ K-th /wtf event in the
    // transcript. Record A is session position 0 → /wtf #1, capturing the
    // partial response before /wtf #2.
    const transcriptFile = writeTranscript(tmpDir, 'sess-chained-interrupt', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: "You're right that —" }], 't2'),
      slashCommandEvent('gripewright:wtf', 'still bad', 't3'),
    ]);
    store.appendRecord({ session_id: 'sess-chained-interrupt', n: 1 }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess-chained-interrupt', transcript_path: transcriptFile }),
      logFile,
    });

    const records = store.readAllRecords({ logFile });
    assert.equal(records.length, 1);
    assert.equal(records[0].wtf_response.length, 1);
    assert.equal(records[0].wtf_response[0].type, 'text');
    assert.equal(records[0].wtf_response[0].text, "You're right that —");
  });

  it('no-op when transcript has no /wtf invocation', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess9', [
      userEvent('regular prompt', 't1'),
      assistantEvent([{ type: 'text', text: 'regular reply' }], 't2'),
      userEvent('another prompt', 't3'),
    ]);
    store.appendRecord({ session_id: 'sess9' }, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess9', transcript_path: transcriptFile }),
      logFile,
    });

    const rec = store.readAllRecords({ logFile })[0];
    assert.ok(!('wtf_response' in rec));
  });

  it('handles missing transcript file silently', async () => {
    store.appendRecord({ session_id: 'sess10' }, { logFile });

    const code = await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess10', transcript_path: path.join(tmpDir, 'nope.jsonl') }),
      logFile,
    });

    assert.equal(code, 0);
    assert.ok(!('wtf_response' in store.readAllRecords({ logFile })[0]));
  });

  it('handles invalid stdin payload silently', async () => {
    store.appendRecord({ session_id: 'sess11' }, { logFile });

    assert.equal(await onUserPromptSubmit.main({ stdin: 'not json', logFile }), 0);
    assert.equal(await onUserPromptSubmit.main({ stdin: '', logFile }), 0);
    assert.equal(await onUserPromptSubmit.main({ stdin: '{}', logFile }), 0);
  });

  it('atomic rewrite preserves other records byte-identical', async () => {
    const transcriptFile = writeTranscript(tmpDir, 'sess12', [
      slashCommandEvent('gripewright:wtf', '', 't1'),
      assistantEvent([{ type: 'text', text: 'partial' }], 't2'),
      userEvent('next', 't3'),
    ]);
    const r1 = { session_id: 'other-a', n: 1 };
    const r2 = { session_id: 'sess12', n: 2 };
    const r3 = { session_id: 'other-b', n: 3 };
    store.appendRecord(r1, { logFile });
    store.appendRecord(r2, { logFile });
    store.appendRecord(r3, { logFile });

    await onUserPromptSubmit.main({
      stdin: makeStdin({ session_id: 'sess12', transcript_path: transcriptFile }),
      logFile,
    });

    const records = store.readAllRecords({ logFile });
    assert.equal(records.length, 3);
    assert.deepEqual(records[0], r1);
    assert.deepEqual(records[2], r3);
    assert.ok('wtf_response' in records[1]);
    assert.equal(records[1].wtf_response[0].text, 'partial');
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

    it('logs and exits 0 when readAllRecords throws', async (t) => {
      const transcriptFile = writeTranscript(tmpDir, 'diag1', [
        slashCommandEvent('gripewright:wtf', '', 't1'),
        assistantEvent([{ type: 'text', text: 'r' }], 't2'),
      ]);
      store.appendRecord({ session_id: 'diag1' }, { logFile });
      const writes = captureStderr(t);
      t.mock.method(store, 'readAllRecords', () => { throw new Error('boom-readlog'); });

      const code = await onUserPromptSubmit.main({
        stdin: makeStdin({ session_id: 'diag1', transcript_path: transcriptFile }),
        logFile,
      });

      assert.equal(code, 0);
      const out = writes.join('');
      assert.match(out, /\[gripewright\/on-user-prompt-submit\] read log failed:/);
      assert.match(out, /boom-readlog/);
    });

    it('logs and exits 0 when readTranscript throws', async (t) => {
      const transcriptFile = writeTranscript(tmpDir, 'diag2', [
        slashCommandEvent('gripewright:wtf', '', 't1'),
        assistantEvent([{ type: 'text', text: 'r' }], 't2'),
      ]);
      store.appendRecord({ session_id: 'diag2' }, { logFile });
      const writes = captureStderr(t);
      t.mock.method(transcript, 'readTranscript', () => { throw new Error('boom-read'); });

      const code = await onUserPromptSubmit.main({
        stdin: makeStdin({ session_id: 'diag2', transcript_path: transcriptFile }),
        logFile,
      });

      assert.equal(code, 0);
      const out = writes.join('');
      assert.match(out, /\[gripewright\/on-user-prompt-submit\] read transcript failed:/);
      assert.match(out, /boom-read/);
    });

    it('logs and exits 0 when rewriteAllRecords throws', async (t) => {
      const transcriptFile = writeTranscript(tmpDir, 'diag3', [
        slashCommandEvent('gripewright:wtf', '', 't1'),
        assistantEvent([{ type: 'text', text: 'r' }], 't2'),
      ]);
      store.appendRecord({ session_id: 'diag3' }, { logFile });
      const writes = captureStderr(t);
      t.mock.method(store, 'rewriteAllRecords', () => { throw new Error('boom-rewrite'); });

      const code = await onUserPromptSubmit.main({
        stdin: makeStdin({ session_id: 'diag3', transcript_path: transcriptFile }),
        logFile,
      });

      assert.equal(code, 0);
      const out = writes.join('');
      assert.match(out, /\[gripewright\/on-user-prompt-submit\] rewrite log failed:/);
      assert.match(out, /boom-rewrite/);
    });
  });
});
