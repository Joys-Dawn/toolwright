'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NON_USER_TAG_PREFIXES = [
  '<system-reminder',
  '<local-command-stdout',
  '<local-command-stderr',
];

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isSyntheticUserMarker(text) {
  const head = text.trimStart().slice(0, 80).toLowerCase();
  return NON_USER_TAG_PREFIXES.some(p => head.startsWith(p));
}

function contentToText(content) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const x of content) {
      if (isPlainObject(x) && x.type === 'text') {
        parts.push(x.text || '');
      }
    }
    return parts.join('\n');
  }
  return String(content);
}

function isRealUserMessage(event) {
  if (!event || event.type !== 'user') return false;
  if (event.isMeta) return false;
  const msg = event.message;
  if (!isPlainObject(msg)) return false;
  const content = msg.content ?? '';
  if (Array.isArray(content) && content.some(x => isPlainObject(x) && x.type === 'tool_result')) {
    return false;
  }
  const text = contentToText(content);
  if (!text.trim()) return false;
  if (isSyntheticUserMarker(text)) return false;
  if (text.trim() === '[Request interrupted by user]') return false;
  return true;
}

function isGripewrightWtfInvocation(event) {
  const msg = event?.message;
  if (!isPlainObject(msg)) return false;
  const head = contentToText(msg.content ?? '').slice(0, 500);
  return head.includes('<command-name>/gripewright:wtf</command-name>')
      || head.includes('<command-message>gripewright:wtf</command-message>');
}

function extractUserText(event) {
  const msg = event?.message;
  if (!isPlainObject(msg)) return '';
  return contentToText(msg.content ?? '');
}

function extractAssistantBlocks(event) {
  const msg = event?.message;
  if (!isPlainObject(msg)) return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const c of content) {
    if (!isPlainObject(c)) continue;
    if (c.type === 'thinking') {
      blocks.push({ type: 'thinking', text: c.thinking || '' });
    } else if (c.type === 'text') {
      blocks.push({ type: 'text', text: c.text || '' });
    } else if (c.type === 'tool_use') {
      blocks.push({ type: 'tool_use', name: c.name ?? null, input: c.input ?? null });
    }
  }
  return blocks;
}

function extractToolResult(event) {
  const msg = event?.message;
  if (!isPlainObject(msg)) return null;
  const content = msg.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (isPlainObject(c) && c.type === 'tool_result') {
      let inner = c.content ?? '';
      if (Array.isArray(inner)) {
        inner = inner
          .map(x => isPlainObject(x) ? (x.text || '') : String(x))
          .join('\n');
      }
      return { type: 'tool_result', content: String(inner) };
    }
  }
  return null;
}

function findSessionJsonl(sessionId, opts = {}) {
  const home = opts.home ?? os.homedir();
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const target = `${sessionId}.jsonl`;

  const queue = [projectsDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === target) {
        return full;
      }
      if (ent.isDirectory()) {
        queue.push(full);
      }
    }
  }
  return null;
}

function readTranscript(jsonlPath) {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
    }
  }
  return events;
}

module.exports = {
  isSyntheticUserMarker,
  contentToText,
  isRealUserMessage,
  isGripewrightWtfInvocation,
  extractUserText,
  extractAssistantBlocks,
  extractToolResult,
  findSessionJsonl,
  readTranscript,
};
