#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getActiveAgents, readAgents } = require('../lib/agents');
const { readContext } = require('../lib/context');
const { getLastSeenHash, setLastSeenHash } = require('../lib/last-seen');
const { hashString } = require('../lib/hash');
const { INACTIVE_THRESHOLD_MS, validateSessionId } = require('../lib/constants');
const { toPosixPath, matchesGlob } = require('../lib/glob');
// scavenging is handled by heartbeat.js — guard only reads state

function stripPrefix(filePath) {
  if (typeof filePath !== 'string') {
    return null;
  }
  return filePath.replace(/^[+~-]/, '');
}

function isPathWithin(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getTrackedFiles(otherContexts, cwd) {
  const tracked = [];

  for (const ctx of otherContexts) {
    for (const file of ctx.files || []) {
      // Skip files being deleted — no conflict if both agents delete
      if (typeof file === 'string' && file.startsWith('-')) continue;
      const normalized = stripPrefix(file);
      if (!normalized) continue;
      tracked.push({
        sessionId: ctx.sessionId,
        task: ctx.task,
        files: ctx.files || [],
        functions: ctx.functions || [],
        absolutePath: path.resolve(cwd, normalized),
        relativePath: normalized
      });
    }
  }

  return tracked;
}

function getOverlappingContexts(toolName, toolInput, trackedFiles, cwd) {
  if (!toolName || !toolInput || typeof toolInput !== 'object') {
    return [];
  }

  const overlaps = new Map();

  const addOverlap = tracked => {
    if (!overlaps.has(tracked.sessionId)) {
      overlaps.set(tracked.sessionId, {
        sessionId: tracked.sessionId,
        task: tracked.task,
        files: tracked.files,
        functions: tracked.functions
      });
    }
  };

  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
    const target = path.resolve(cwd, toolInput.file_path);
    for (const tracked of trackedFiles) {
      if (tracked.absolutePath === target) {
        addOverlap(tracked);
      }
    }
    return [...overlaps.values()];
  }

  if (toolName === 'Glob' || toolName === 'Grep') {
    const searchPath = path.resolve(cwd, toolInput.path || '.');
    const searchExists = fs.existsSync(searchPath);
    const isDirectory = searchExists ? fs.statSync(searchPath).isDirectory() : true;

    for (const tracked of trackedFiles) {
      if (isDirectory) {
        if (!isPathWithin(searchPath, tracked.absolutePath)) {
          continue;
        }
        const relative = path.relative(searchPath, tracked.absolutePath);
        if (toolName === 'Glob') {
          if (matchesGlob(relative, toolInput.pattern)) {
            addOverlap(tracked);
          }
        } else {
          if (!toolInput.glob || matchesGlob(relative, toolInput.glob)) {
            addOverlap(tracked);
          }
        }
      } else if (tracked.absolutePath === searchPath) {
        if (toolName === 'Grep') {
          if (!toolInput.glob || matchesGlob(path.basename(tracked.absolutePath), toolInput.glob)) {
            addOverlap(tracked);
          }
        } else {
          addOverlap(tracked);
        }
      }
    }
  }

  return [...overlaps.values()];
}

function buildSummary(contexts) {
  const lines = ['Other agents are active in this codebase:'];
  for (const ctx of contexts) {
    const shortId = ctx.sessionId.substring(0, 8);
    const fileList = (ctx.files || []).join(', ');
    const funcList = (ctx.functions || []).join(', ');
    let detail = `- Agent ${shortId}: ${ctx.task || 'no task description'}`;
    if (fileList) detail += ` (files: ${fileList})`;
    if (funcList) detail += ` (functions: ${funcList})`;
    lines.push(detail);
  }
  lines.push('Consider whether your edit conflicts with their work. If so, ask the user for guidance.');
  return lines.join('\n');
}

function allowWithAdditionalContext(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      additionalContext: message
    }
  }));
  process.exit(0);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const { session_id, cwd, tool_name, tool_input } = JSON.parse(input);
  const toolName = tool_name;
  if (!session_id || !cwd || !toolName) {
    process.exit(0);
  }
  validateSessionId(session_id);

  const collabDir = path.join(cwd, '.collab');

  // If .collab doesn't exist, no collab active
  if (!fs.existsSync(collabDir)) {
    process.exit(0);
  }

  // Check if this agent was idle long enough to have lost its context
  const allAgents = readAgents(collabDir);
  const selfAgent = allAgents[session_id];
  if (selfAgent && (Date.now() - selfAgent.last_active) > INACTIVE_THRESHOLD_MS) {
    const selfContext = readContext(collabDir, session_id);
    if (!selfContext) {
      allowWithAdditionalContext(
        'Your session was inactive and your collaboration context was cleared. ' +
        'Use /wrightward:collab-context to re-declare what you are working on so other agents can see your files.'
      );
      return;
    }
  }

  // Get active agents (excluding this one)
  const activeAgents = getActiveAgents(collabDir, INACTIVE_THRESHOLD_MS);
  delete activeAgents[session_id];

  if (Object.keys(activeAgents).length === 0) {
    process.exit(0);
  }

  // Read other agents' contexts, skip missing and status=done
  const otherContexts = [];
  for (const agentId of Object.keys(activeAgents)) {
    const ctx = readContext(collabDir, agentId);
    if (!ctx) continue;
    if (ctx.status === 'done') continue;
    otherContexts.push({ sessionId: agentId, ...ctx });
  }

  if (otherContexts.length === 0) {
    process.exit(0);
  }

  const trackedFiles = getTrackedFiles(otherContexts, cwd);

  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    handleReadTool(toolName, tool_input, trackedFiles, cwd, collabDir, session_id);
    return;
  }

  handleWriteTool(toolName, tool_input, trackedFiles, cwd, collabDir, session_id, otherContexts);
}

function handleReadTool(toolName, toolInput, trackedFiles, cwd, collabDir, sessionId) {
  const overlaps = getOverlappingContexts(toolName, toolInput, trackedFiles, cwd);
  if (overlaps.length === 0) {
    process.exit(0);
  }
  const summary = buildSummary(overlaps);
  const summaryHash = hashString(summary);
  const lastSeen = getLastSeenHash(collabDir, sessionId);
  if (lastSeen === summaryHash) {
    process.exit(0);
  }
  setLastSeenHash(collabDir, sessionId, summaryHash);
  allowWithAdditionalContext(summary);
}

function handleWriteTool(toolName, toolInput, trackedFiles, cwd, collabDir, sessionId, otherContexts) {
  const overlaps = getOverlappingContexts(toolName, toolInput, trackedFiles, cwd);
  if (overlaps.length > 0) {
    const myContext = readContext(collabDir, sessionId);
    if (!myContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          reason: 'no_context_declared',
          message: 'Another agent is working on files that overlap with this edit. ' +
            'Use /wrightward:collab-context to declare what you are working on first.',
          overlappingAgents: overlaps
        }
      }));
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        reason: 'file_overlap',
        message: buildSummary(overlaps),
        overlappingAgents: overlaps
      }
    }));
    process.exit(2);
  }

  // No file overlap — inject non-blocking context only when something changed
  otherContexts.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const contextHash = hashString(JSON.stringify(otherContexts));
  const lastSeen = getLastSeenHash(collabDir, sessionId);
  if (lastSeen === contextHash) {
    process.exit(0);
  }
  setLastSeenHash(collabDir, sessionId, contextHash);
  allowWithAdditionalContext(buildSummary(otherContexts));
}

main().catch(err => {
  process.stderr.write('[collab/guard] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
