'use strict';

// Helpers for reading Claude Code session transcripts (JSONL files under
// ~/.claude/projects/<project-slug>/<sessionId>.jsonl). Adapted from
// gripewright/lib/transcript.js with plan-mode-specific finders added.
//
// Schema observed against Claude Code 2.1.119. Fields used:
//   - event.type: "user" | "assistant" | "attachment" | "system" | ...
//   - event.uuid: string
//   - event.message.content: array of content blocks (for user/assistant)
//   - content blocks: { type: "text" | "thinking" | "tool_use" | "tool_result" }
//   - tool_use blocks: { id, name, input }
//   - tool_result blocks: { tool_use_id, content, is_error? }
//   - attachment events: { attachment: { type: "plan_mode", planFilePath, ... } }

const fs = require('fs');
const os = require('os');
const path = require('path');

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function findSessionJsonl(sessionId, opts = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
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
      if (ent.isFile() && ent.name === target) return full;
      if (ent.isDirectory()) queue.push(full);
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
      // ignore malformed lines
    }
  }
  return events;
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
      blocks.push({ type: 'tool_use', id: c.id ?? null, name: c.name ?? null, input: c.input ?? null });
    }
  }
  return blocks;
}

function findLastPlanAttachment(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!isPlainObject(ev)) continue;
    if (ev.type !== 'attachment') continue;
    const att = ev.attachment;
    if (!isPlainObject(att)) continue;
    if (att.type !== 'plan_mode') continue;
    if (typeof att.planFilePath !== 'string' || !att.planFilePath) continue;
    return ev;
  }
  return null;
}

function findLastToolUseByName(events, toolName) {
  if (!Array.isArray(events) || !toolName) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!isPlainObject(ev) || ev.type !== 'assistant') continue;
    const blocks = extractAssistantBlocks(ev);
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name === toolName) {
        return { event: ev, toolUseId: b.id, input: b.input };
      }
    }
  }
  return null;
}

function findLastExitPlanMode(events) {
  return findLastToolUseByName(events, 'ExitPlanMode');
}

function extractToolResultsByToolUseId(events) {
  const map = new Map();
  if (!Array.isArray(events)) return map;
  for (const ev of events) {
    if (!isPlainObject(ev) || ev.type !== 'user') continue;
    const msg = ev.message;
    if (!isPlainObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!isPlainObject(c) || c.type !== 'tool_result') continue;
      if (typeof c.tool_use_id !== 'string') continue;
      let inner = c.content ?? '';
      if (Array.isArray(inner)) {
        inner = inner
          .map(x => isPlainObject(x) ? (x.text || '') : String(x))
          .join('\n');
      }
      map.set(c.tool_use_id, {
        content: String(inner),
        isError: c.is_error === true
      });
    }
  }
  return map;
}

function indexOfEventByUuid(events, uuid) {
  if (!Array.isArray(events) || !uuid) return -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.uuid === uuid) return i;
  }
  return -1;
}

module.exports = {
  isPlainObject,
  findSessionJsonl,
  readTranscript,
  extractAssistantBlocks,
  findLastPlanAttachment,
  findLastToolUseByName,
  findLastExitPlanMode,
  extractToolResultsByToolUseId,
  indexOfEventByUuid
};
