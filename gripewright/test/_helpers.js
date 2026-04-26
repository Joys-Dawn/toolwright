'use strict';

const fs = require('fs');
const path = require('path');

const TS = '2024-01-01T00:00:00Z';

function writeSession(home, sessionId, events, projectName = 'fake-project') {
  const projectDir = path.join(home, '.claude', 'projects', projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

function userEvent(text, timestamp = TS) {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    timestamp,
    sessionId: 'test-session',
    cwd: '/test',
    gitBranch: 'main',
  };
}

function slashCommandEvent(name, args = '', timestamp = TS) {
  let text = `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`;
  if (args) text += `\n<command-args>${args}</command-args>`;
  return userEvent(text, timestamp);
}

function toolResultEvent(content, timestamp = TS) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content }] },
    timestamp,
    sessionId: 'test-session',
    cwd: '/test',
    gitBranch: 'main',
  };
}

function assistantEvent(blocks, timestamp = TS) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: blocks },
    timestamp,
    sessionId: 'test-session',
    cwd: '/test',
    gitBranch: 'main',
  };
}

module.exports = {
  TS,
  userEvent,
  slashCommandEvent,
  toolResultEvent,
  assistantEvent,
  writeSession,
};
