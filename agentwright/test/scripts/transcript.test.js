'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  isPlainObject,
  findSessionJsonl,
  readTranscript,
  extractAssistantBlocks,
  findLastPlanAttachment,
  findLastToolUseByName,
  findLastExitPlanMode,
  extractToolResultsByToolUseId,
  indexOfEventByUuid
} = require('../../scripts/transcript');

describe('transcript helpers', () => {
  describe('isPlainObject', () => {
    it('returns true for plain objects', () => {
      assert.equal(isPlainObject({}), true);
      assert.equal(isPlainObject({ a: 1 }), true);
    });

    it('returns false for arrays, null, primitives', () => {
      assert.equal(isPlainObject([]), false);
      assert.equal(isPlainObject(null), false);
      assert.equal(isPlainObject('x'), false);
      assert.equal(isPlainObject(42), false);
      assert.equal(isPlainObject(undefined), false);
    });
  });

  describe('extractAssistantBlocks', () => {
    it('returns text, thinking, and tool_use blocks', () => {
      const ev = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'thinking', thinking: 'pondering' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { p: 'a' } }
          ]
        }
      };
      const blocks = extractAssistantBlocks(ev);
      assert.equal(blocks.length, 3);
      assert.deepEqual(blocks[0], { type: 'text', text: 'hi' });
      assert.deepEqual(blocks[1], { type: 'thinking', text: 'pondering' });
      assert.deepEqual(blocks[2], { type: 'tool_use', id: 't1', name: 'Read', input: { p: 'a' } });
    });

    it('returns empty array when content is missing or malformed', () => {
      assert.deepEqual(extractAssistantBlocks({}), []);
      assert.deepEqual(extractAssistantBlocks({ message: { content: 'plain' } }), []);
      assert.deepEqual(extractAssistantBlocks(null), []);
    });

    it('skips unknown block types', () => {
      const ev = {
        message: {
          content: [
            { type: 'text', text: 'a' },
            { type: 'unknown_block', stuff: 1 }
          ]
        }
      };
      const blocks = extractAssistantBlocks(ev);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].text, 'a');
    });
  });

  describe('findLastPlanAttachment', () => {
    it('returns the most recent plan_mode attachment event', () => {
      const events = [
        { uuid: '1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: '/old.md' } },
        { uuid: '2', type: 'user', message: { content: 'hi' } },
        { uuid: '3', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: '/new.md' } }
      ];
      const result = findLastPlanAttachment(events);
      assert.equal(result.uuid, '3');
      assert.equal(result.attachment.planFilePath, '/new.md');
    });

    it('returns null when no plan_mode attachment exists', () => {
      const events = [
        { type: 'user', message: { content: 'hi' } },
        { type: 'attachment', attachment: { type: 'todo' } }
      ];
      assert.equal(findLastPlanAttachment(events), null);
    });

    it('skips attachments missing planFilePath', () => {
      const events = [
        { uuid: '1', type: 'attachment', attachment: { type: 'plan_mode', planFilePath: '/keep.md' } },
        { uuid: '2', type: 'attachment', attachment: { type: 'plan_mode' } }
      ];
      const result = findLastPlanAttachment(events);
      assert.equal(result.uuid, '1');
    });

    it('returns null on non-array input', () => {
      assert.equal(findLastPlanAttachment(null), null);
      assert.equal(findLastPlanAttachment(undefined), null);
    });
  });

  describe('findLastToolUseByName / findLastExitPlanMode', () => {
    it('returns the most recent matching tool_use', () => {
      const events = [
        {
          uuid: 'a', type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: {} }] }
        },
        {
          uuid: 'b', type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { p: 'x' } }] }
        },
        {
          uuid: 'c', type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't3', name: 'ExitPlanMode', input: {} }] }
        }
      ];
      const result = findLastExitPlanMode(events);
      assert.equal(result.event.uuid, 'c');
      assert.equal(result.toolUseId, 't3');
    });

    it('returns null when name not present', () => {
      const events = [
        { uuid: 'a', type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
      ];
      assert.equal(findLastExitPlanMode(events), null);
      assert.equal(findLastToolUseByName(events, 'Foo'), null);
    });

    it('returns null on missing input', () => {
      assert.equal(findLastToolUseByName([], 'Foo'), null);
      assert.equal(findLastToolUseByName(null, 'Foo'), null);
      assert.equal(findLastToolUseByName([{}], ''), null);
    });
  });

  describe('extractToolResultsByToolUseId', () => {
    it('builds a map keyed by tool_use_id with content and isError', () => {
      const events = [
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }
            ]
          }
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'boom' }], is_error: true }
            ]
          }
        }
      ];
      const map = extractToolResultsByToolUseId(events);
      assert.equal(map.size, 2);
      assert.deepEqual(map.get('t1'), { content: 'ok', isError: false });
      assert.deepEqual(map.get('t2'), { content: 'boom', isError: true });
    });

    it('returns empty map when no tool_result events exist', () => {
      assert.equal(extractToolResultsByToolUseId([]).size, 0);
      assert.equal(extractToolResultsByToolUseId([{ type: 'user', message: { content: 'hi' } }]).size, 0);
    });

    it('ignores tool_results without tool_use_id', () => {
      const events = [
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'orphan' }] }
        }
      ];
      assert.equal(extractToolResultsByToolUseId(events).size, 0);
    });

    it('joins array content that mixes object blocks and primitives', () => {
      const events = [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'mixed',
                content: ['plain string', { type: 'text', text: 'block' }, 42]
              }
            ]
          }
        }
      ];

      const map = extractToolResultsByToolUseId(events);

      assert.equal(map.get('mixed').content, 'plain string\nblock\n42');
    });
  });

  describe('indexOfEventByUuid', () => {
    it('returns the index of the matching event', () => {
      const events = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
      assert.equal(indexOfEventByUuid(events, 'b'), 1);
    });

    it('returns -1 when not found', () => {
      assert.equal(indexOfEventByUuid([{ uuid: 'a' }], 'z'), -1);
      assert.equal(indexOfEventByUuid([], 'a'), -1);
      assert.equal(indexOfEventByUuid(null, 'a'), -1);
      assert.equal(indexOfEventByUuid([{ uuid: 'a' }], ''), -1);
    });
  });

  describe('findSessionJsonl + readTranscript (filesystem)', () => {
    let homeDir;

    beforeEach(() => {
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    });

    afterEach(() => {
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it('finds a session jsonl under nested project dirs', () => {
      const projectDir = path.join(homeDir, '.claude', 'projects', 'project-a');
      fs.mkdirSync(projectDir, { recursive: true });
      const target = path.join(projectDir, 'sess-1.jsonl');
      fs.writeFileSync(target, '{"uuid":"x"}\n', 'utf8');

      const found = findSessionJsonl('sess-1', { home: homeDir });
      assert.equal(found, target);
    });

    it('returns null when sessionId is empty or missing', () => {
      assert.equal(findSessionJsonl('', { home: homeDir }), null);
      assert.equal(findSessionJsonl(null, { home: homeDir }), null);
    });

    it('returns null when projects dir does not exist', () => {
      assert.equal(findSessionJsonl('any', { home: homeDir }), null);
    });

    it('readTranscript parses JSONL and skips blank lines', () => {
      const file = path.join(homeDir, 'demo.jsonl');
      fs.writeFileSync(file, '{"a":1}\n\n{"b":2}\nnot json\n{"c":3}\n', 'utf8');
      const events = readTranscript(file);
      assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    });
  });
});
