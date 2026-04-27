'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../lib/transcript');
const { userEvent, slashCommandEvent, toolResultEvent, assistantEvent } = require('./_helpers');

describe('contentToText', () => {
  it('passes string content through', () => {
    assert.equal(t.contentToText('hello'), 'hello');
  });

  it('joins list of text blocks with newline', () => {
    const content = [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ];
    assert.equal(t.contentToText(content), 'one\ntwo');
  });

  it('skips non-text blocks in list', () => {
    const content = [
      { type: 'text', text: 'kept' },
      { type: 'image', source: 'foo' },
      { type: 'text', text: 'kept2' },
    ];
    assert.equal(t.contentToText(content), 'kept\nkept2');
  });

  it('skips non-dict items in list', () => {
    const content = ['str', null, { type: 'text', text: 'kept' }, 42];
    assert.equal(t.contentToText(content), 'kept');
  });

  it('returns empty string for empty list', () => {
    assert.equal(t.contentToText([]), '');
  });

  it('coerces non-string non-list via String()', () => {
    assert.equal(t.contentToText(42), '42');
  });
});

describe('isRealUserMessage', () => {
  it('plain text user message is real', () => {
    assert.equal(t.isRealUserMessage(userEvent('hello')), true);
  });

  it('assistant event is not real user', () => {
    assert.equal(t.isRealUserMessage(assistantEvent([{ type: 'text', text: 'hi' }])), false);
  });

  it('isMeta user event filtered', () => {
    const ev = userEvent('hello');
    ev.isMeta = true;
    assert.equal(t.isRealUserMessage(ev), false);
  });

  it('message not dict filtered', () => {
    const ev = { type: 'user', message: 'not-a-dict' };
    assert.equal(t.isRealUserMessage(ev), false);
  });

  it('tool_result in content filtered', () => {
    assert.equal(t.isRealUserMessage(toolResultEvent('result')), false);
  });

  it('empty content filtered', () => {
    assert.equal(t.isRealUserMessage(userEvent('')), false);
    assert.equal(t.isRealUserMessage(userEvent('   \n  ')), false);
  });

  it('system-reminder synthetic filtered', () => {
    assert.equal(t.isRealUserMessage(userEvent('<system-reminder>injected</system-reminder>')), false);
  });

  it('local-command-stdout filtered', () => {
    assert.equal(t.isRealUserMessage(userEvent('<local-command-stdout>script ran</local-command-stdout>')), false);
  });

  it('local-command-stderr filtered', () => {
    assert.equal(t.isRealUserMessage(userEvent('<local-command-stderr>error</local-command-stderr>')), false);
  });

  it('interrupt marker filtered (regression)', () => {
    assert.equal(t.isRealUserMessage(userEvent('[Request interrupted by user]')), false);
  });

  it('interrupt-during-tool-use marker filtered (regression)', () => {
    assert.equal(t.isRealUserMessage(userEvent('[Request interrupted by user for tool use]')), false);
  });

  it('real slash command invocation is real user', () => {
    const ev = slashCommandEvent('agentwright:critique', 'this design');
    assert.equal(t.isRealUserMessage(ev), true);
  });

  it('gripewright:wtf invocation is also real user (caller decides skip)', () => {
    const ev = slashCommandEvent('gripewright:wtf', 'lazy');
    assert.equal(t.isRealUserMessage(ev), true);
  });
});

describe('isGripewrightWtfInvocation', () => {
  it('matches command-name form', () => {
    const ev = userEvent('something <command-name>/gripewright:wtf</command-name> trailing');
    assert.equal(t.isGripewrightWtfInvocation(ev), true);
  });

  it('matches command-message form', () => {
    const ev = userEvent('something <command-message>gripewright:wtf</command-message> trailing');
    assert.equal(t.isGripewrightWtfInvocation(ev), true);
  });

  it('matches full slash command invocation with args', () => {
    const ev = slashCommandEvent('gripewright:wtf', '3 lazy answer');
    assert.equal(t.isGripewrightWtfInvocation(ev), true);
  });

  it('does not match other slash commands', () => {
    const ev = slashCommandEvent('agentwright:critique');
    assert.equal(t.isGripewrightWtfInvocation(ev), false);
  });

  it('does not match plain text', () => {
    assert.equal(t.isGripewrightWtfInvocation(userEvent('wtf was that')), false);
  });

  it('returns false when message not dict', () => {
    assert.equal(t.isGripewrightWtfInvocation({ type: 'user', message: 'not-a-dict' }), false);
  });

  it('does not match assistant messages that mention the marker as text (regression)', () => {
    // An assistant explanation that quotes the marker literally must not be
    // treated as a /wtf invocation — that false-positive paired log records
    // with the wrong transcript event and produced empty wtf_response arrays.
    const ev = assistantEvent([
      { type: 'text', text: 'matches only <command-name>/gripewright:wtf</command-name> exactly' },
    ]);
    assert.equal(t.isGripewrightWtfInvocation(ev), false);
  });
});

describe('extractAssistantBlocks', () => {
  it('extracts thinking, text, tool_use blocks in order', () => {
    const ev = assistantEvent([
      { type: 'thinking', thinking: 'reasoning...' },
      { type: 'text', text: 'visible answer' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ]);
    const blocks = t.extractAssistantBlocks(ev);
    assert.deepEqual(blocks, [
      { type: 'thinking', text: 'reasoning...' },
      { type: 'text', text: 'visible answer' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('skips unknown block types', () => {
    const ev = assistantEvent([
      { type: 'text', text: 'kept' },
      { type: 'mystery', data: 'x' },
      { type: 'text', text: 'also kept' },
    ]);
    const blocks = t.extractAssistantBlocks(ev);
    assert.equal(blocks.length, 2);
  });

  it('skips non-dict blocks', () => {
    const ev = assistantEvent(['string-block', null, { type: 'text', text: 'kept' }]);
    const blocks = t.extractAssistantBlocks(ev);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, 'kept');
  });

  it('missing fields default to empty / null', () => {
    const ev = assistantEvent([
      { type: 'thinking' },
      { type: 'text' },
      { type: 'tool_use' },
    ]);
    const blocks = t.extractAssistantBlocks(ev);
    assert.deepEqual(blocks[0], { type: 'thinking', text: '' });
    assert.deepEqual(blocks[1], { type: 'text', text: '' });
    assert.deepEqual(blocks[2], { type: 'tool_use', name: null, input: null });
  });

  it('returns empty list when message not dict', () => {
    assert.deepEqual(t.extractAssistantBlocks({ type: 'assistant', message: 'no' }), []);
  });
});

describe('extractToolResult', () => {
  it('returns string content as-is', () => {
    assert.deepEqual(t.extractToolResult(toolResultEvent('plain result')), {
      type: 'tool_result',
      content: 'plain result',
    });
  });

  it('does not truncate long content (regression)', () => {
    const long = 'x'.repeat(10000);
    const result = t.extractToolResult(toolResultEvent(long));
    assert.equal(result.content.length, 10000);
  });

  it('joins list of text blocks', () => {
    const ev = toolResultEvent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    assert.equal(t.extractToolResult(ev).content, 'first\nsecond');
  });

  it('returns null when no tool_result block', () => {
    const ev = userEvent('plain');
    assert.equal(t.extractToolResult(ev), null);
  });

  it('returns null when content is not list', () => {
    const ev = { type: 'user', message: { role: 'user', content: 'string-not-list' } };
    assert.equal(t.extractToolResult(ev), null);
  });

  it('returns null when message not dict', () => {
    assert.equal(t.extractToolResult({ type: 'user', message: 'no' }), null);
  });
});

describe('findSessionJsonl', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-find-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns path when jsonl exists in a project subdir', () => {
    const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
    fs.mkdirSync(projDir, { recursive: true });
    const target = path.join(projDir, 'sess-abc.jsonl');
    fs.writeFileSync(target, '');
    const result = t.findSessionJsonl('sess-abc', { home: tmpHome });
    assert.equal(result, target);
  });

  it('returns null when session id is missing', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
    assert.equal(t.findSessionJsonl('nope', { home: tmpHome }), null);
  });
});

describe('readTranscript', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-read-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses valid lines and skips malformed ones', () => {
    const file = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', n: 1 }),
      'not valid json',
      JSON.stringify({ type: 'assistant', n: 2 }),
      '',
    ].join('\n'));
    const events = t.readTranscript(file);
    assert.equal(events.length, 2);
    assert.equal(events[0].n, 1);
    assert.equal(events[1].n, 2);
  });

  it('returns empty array for empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    assert.deepEqual(t.readTranscript(file), []);
  });
});
