#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getActiveAgents, readAgents } = require('../lib/agents');
const { readContext } = require('../lib/context');
const { getContextHash, setContextHash } = require('../lib/context-hash');
const { hashString } = require('../lib/hash');
const { loadConfig } = require('../lib/config');
const { resolveCollabDir } = require('../lib/collab-dir');
const { validateSessionId } = require('../lib/constants');
const { toPosixPath, matchesGlob } = require('../lib/glob');
// scavenging is handled by heartbeat.js — guard only reads state

function isPathWithin(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getTrackedFiles(otherContexts, cwd) {
  const tracked = [];

  for (const ctx of otherContexts) {
    for (const file of ctx.files || []) {
      // File entries are objects (written by context.js and heartbeat.js). Skip deletions.
      if (!file || !file.path) continue;
      if (file.prefix === '-') continue;
      tracked.push({
        sessionId: ctx.sessionId,
        task: ctx.task,
        files: ctx.files || [],
        functions: ctx.functions || [],
        absolutePath: path.resolve(cwd, file.path),
        relativePath: file.path
      });
    }
  }

  return tracked;
}

function getOverlappingContexts(tool_name, tool_input, trackedFiles, cwd) {
  if (!tool_name || !tool_input || typeof tool_input !== 'object') {
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

  if ((tool_name === 'Read' || tool_name === 'Write' || tool_name === 'Edit') && tool_input.file_path) {
    const target = path.resolve(cwd, tool_input.file_path);
    for (const tracked of trackedFiles) {
      if (tracked.absolutePath === target) {
        addOverlap(tracked);
      }
    }
    return [...overlaps.values()];
  }

  if (tool_name === 'Glob' || tool_name === 'Grep') {
    const searchPath = path.resolve(cwd, tool_input.path || '.');
    const searchExists = fs.existsSync(searchPath);
    const isDirectory = searchExists ? fs.statSync(searchPath).isDirectory() : true;

    for (const tracked of trackedFiles) {
      if (isDirectory) {
        if (!isPathWithin(searchPath, tracked.absolutePath)) {
          continue;
        }
        const relative = path.relative(searchPath, tracked.absolutePath);
        if (tool_name === 'Glob') {
          if (matchesGlob(relative, tool_input.pattern)) {
            addOverlap(tracked);
          }
        } else {
          if (!tool_input.glob || matchesGlob(relative, tool_input.glob)) {
            addOverlap(tracked);
          }
        }
      } else if (tracked.absolutePath === searchPath) {
        if (tool_name === 'Grep') {
          if (!tool_input.glob || matchesGlob(path.basename(tracked.absolutePath), tool_input.glob)) {
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

function formatFileList(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  return files.filter(f => f && f.path).map(f => (f.prefix || '') + f.path).join(', ');
}

function buildSummary(contexts) {
  const lines = ['Other agents are active in this codebase:'];
  for (const ctx of contexts) {
    const shortId = ctx.sessionId.substring(0, 8);
    const fileList = formatFileList(ctx.files);
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
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
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
  if (!session_id || !cwd || !tool_name) {
    process.exit(0);
  }
  validateSessionId(session_id);

  const resolved = resolveCollabDir(cwd);
  if (!resolved) {
    process.exit(0);
  }
  const { root, collabDir } = resolved;

  const config = loadConfig(root);
  if (!config.ENABLED) process.exit(0);

  // Check if this agent was idle long enough to have lost its context
  const allAgents = readAgents(collabDir);
  const selfAgent = allAgents[session_id];
  if (selfAgent && (Date.now() - selfAgent.last_active) > config.INACTIVE_THRESHOLD_MS) {
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
  const activeAgents = getActiveAgents(collabDir, config.INACTIVE_THRESHOLD_MS);
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

  const trackedFiles = getTrackedFiles(otherContexts, root);

  if (tool_name === 'Read' || tool_name === 'Glob' || tool_name === 'Grep') {
    handleReadTool(tool_name, tool_input, trackedFiles, root, collabDir, session_id);
    return;
  }

  handleWriteTool(tool_name, tool_input, trackedFiles, root, collabDir, session_id, otherContexts);
}

function handleReadTool(tool_name, tool_input, trackedFiles, cwd, collabDir, sessionId) {
  const overlaps = getOverlappingContexts(tool_name, tool_input, trackedFiles, cwd);
  if (overlaps.length === 0) {
    process.exit(0);
  }
  const summary = buildSummary(overlaps);
  const summaryHash = hashString(summary);
  const prevHash = getContextHash(collabDir, sessionId);
  if (prevHash === summaryHash) {
    process.exit(0);
  }
  setContextHash(collabDir, sessionId, summaryHash);
  allowWithAdditionalContext(summary);
}

function handleWriteTool(tool_name, tool_input, trackedFiles, cwd, collabDir, sessionId, otherContexts) {
  const overlaps = getOverlappingContexts(tool_name, tool_input, trackedFiles, cwd);
  if (overlaps.length > 0) {
    const myContext = readContext(collabDir, sessionId);
    if (!myContext) {
      process.stderr.write(
        'Another agent is working on files that overlap with this edit. ' +
        'Use /wrightward:collab-context to declare what you are working on first.'
      );
      process.exit(2);
    }
    process.stderr.write(
      buildSummary(overlaps) + '\nThis file overlaps with another agent\'s claimed files. Skip this edit or ask the user for guidance.'
    );
    process.exit(2);
  }

  // No file overlap — inject non-blocking context only when something changed
  otherContexts.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const contextHash = hashString(JSON.stringify(otherContexts));
  const prevHash = getContextHash(collabDir, sessionId);
  if (prevHash === contextHash) {
    process.exit(0);
  }
  setContextHash(collabDir, sessionId, contextHash);
  allowWithAdditionalContext(buildSummary(otherContexts));
}

main().catch(err => {
  process.stderr.write('[collab/guard] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
