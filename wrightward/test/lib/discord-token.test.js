'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBotToken } = require('../../lib/discord-token');

test('resolveBotToken prefers DISCORD_BOT_TOKEN', () => {
  const env = {
    DISCORD_BOT_TOKEN: 'primary',
    CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN: 'fallback'
  };
  assert.equal(resolveBotToken(env), 'primary');
});

test('resolveBotToken falls back to CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN', () => {
  assert.equal(
    resolveBotToken({ CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN: 'fallback' }),
    'fallback'
  );
});

test('resolveBotToken returns null when both env vars are empty strings', () => {
  assert.equal(
    resolveBotToken({ DISCORD_BOT_TOKEN: '', CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN: '' }),
    null
  );
});

test('resolveBotToken returns null when neither is set', () => {
  assert.equal(resolveBotToken({}), null);
});

test('resolveBotToken handles non-string values as missing', () => {
  assert.equal(
    resolveBotToken({ DISCORD_BOT_TOKEN: 123, CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN: null }),
    null
  );
});

test('resolveBotToken defaults to process.env when no argument is passed', () => {
  const prev = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = 'test-from-process-env';
  try {
    assert.equal(resolveBotToken(), 'test-from-process-env');
  } finally {
    if (prev === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = prev;
  }
});
