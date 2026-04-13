#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getActiveAgents, readAgents, withAgentsLock } = require('../lib/agents');
const { readContext } = require('../lib/context');
const { getContextHash, setContextHash } = require('../lib/context-hash');
const { hashString } = require('../lib/hash');
const { loadConfig } = require('../lib/config');
const { resolveCollabDir } = require('../lib/collab-dir');
const { validateSessionId, isWriteTool } = require('../lib/constants');
const { matchesGlob } = require('../lib/glob');
const { projectRelative } = require('../lib/path-normalize');
const { writeInterest } = require('../lib/bus-query');
const { scanAndFormatInbox } = require('../lib/bus-delivery');
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

/**
 * Scans bus inbox for urgent events and (optionally) emits an interest event
 * for a blocked file in the SAME lock acquisition. Two callers used to take
 * the agents lock back-to-back on a blocked Write — collapsing them avoids
 * a second 5s stale-wait risk and one filesystem round-trip per blocked edit.
 *
 * `interestFile` is the canonical cwd-relative path (already normalized by
 * projectRelative); pass null on the read path or when no overlap fired.
 */
function scanInboxAndMaybeEmitInterest(collabDir, sessionId, config, interestFile) {
  if (!config.BUS_ENABLED) return null;

  let inboxText = null;
  try {
    withAgentsLock(collabDir, (token) => {
      const result = scanAndFormatInbox(token, collabDir, sessionId, config);
      inboxText = result.text;
      if (interestFile) {
        writeInterest(token, collabDir, sessionId, interestFile, config.BUS_INTEREST_TTL_MS);
      }
    });
  } catch (err) {
    process.stderr.write('[collab/guard] inbox scan failed: ' + (err.message || err) + '\n');
  }
  return inboxText;
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

  // Hard block: never allow Edit/Write on files inside .claude/collab/.
  // These files are plugin-managed. The model must never modify them directly —
  // not to release its own claims, not to remove stale claims from other agents,
  // not for any reason. Applies unconditionally, even when this is the only agent.
  // `file_path` must be a string — fail closed on malformed input so bad payloads
  // cannot bypass the hard block via a TypeError in path.resolve.
  if (isWriteTool(tool_name) &&
      tool_input && typeof tool_input.file_path === 'string') {
    const target = path.resolve(root, tool_input.file_path);
    if (isInCollabDir(target, collabDir)) {
      process.stderr.write(
        'BLOCKED: Files in .claude/collab/ are managed by wrightward and must never be modified directly.\n' +
        'Do NOT attempt to edit, delete, or modify any file in .claude/collab/ by any means — not via Edit, Write, or Bash (rm, sed, redirects, etc.). Do NOT try to escalate to Bash after this block fires.\n' +
        'To release your own claims: use /wrightward:collab-release or /wrightward:collab-done.\n' +
        'If you believe another agent\'s claim is stale, ask the user. Never remove another agent\'s claim yourself.'
      );
      process.exit(2);
    }
  }

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

  // Read other agents' contexts, skip missing and status=done
  const otherContexts = [];
  for (const agentId of Object.keys(activeAgents)) {
    const ctx = readContext(collabDir, agentId);
    if (!ctx) continue;
    if (ctx.status === 'done') continue;
    otherContexts.push({ sessionId: agentId, ...ctx });
  }

  // Compute overlap up-front so a blocked Write can scan inbox + emit interest
  // in a single lock acquisition (Sg2).
  const trackedFiles = getTrackedFiles(otherContexts, root);
  const isWrite = isWriteTool(tool_name);
  const overlaps = otherContexts.length > 0
    ? getOverlappingContexts(tool_name, tool_input, trackedFiles, root)
    : [];
  const blockedFile = isWrite && overlaps.length > 0 && tool_input && typeof tool_input.file_path === 'string'
    ? projectRelative(root, tool_input.file_path)
    : null;

  const inboxText = scanInboxAndMaybeEmitInterest(collabDir, session_id, config, blockedFile);

  if (otherContexts.length === 0) {
    // No other agents — but may still have inbox events
    if (inboxText) {
      allowWithAdditionalContext(inboxText);
    }
    process.exit(0);
  }

  if (tool_name === 'Read' || tool_name === 'Glob' || tool_name === 'Grep') {
    handleReadTool(overlaps, collabDir, session_id, inboxText);
    return;
  }

  handleWriteTool(overlaps, collabDir, session_id, otherContexts, inboxText);
}

function handleReadTool(overlaps, collabDir, sessionId, inboxText) {
  if (overlaps.length === 0 && !inboxText) {
    process.exit(0);
  }

  const parts = [];
  if (overlaps.length > 0) {
    parts.push(buildSummary(overlaps));
  }
  if (inboxText) {
    parts.push(inboxText);
  }
  const combined = parts.join('\n\n');

  const combinedHash = hashString(combined);
  const prevHash = getContextHash(collabDir, sessionId);
  if (prevHash === combinedHash) {
    process.exit(0);
  }
  setContextHash(collabDir, sessionId, combinedHash);
  allowWithAdditionalContext(combined);
}

function isInCollabDir(targetPath, collabDir) {
  const target = path.resolve(targetPath);
  const base = path.resolve(collabDir);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function handleWriteTool(overlaps, collabDir, sessionId, otherContexts, inboxText) {
  if (overlaps.length > 0) {
    const myContext = readContext(collabDir, sessionId);
    if (!myContext) {
      process.stderr.write(
        'Another agent is working on files that overlap with this edit. ' +
        'Use /wrightward:collab-context to declare what you are working on first.'
      );
      process.exit(2);
    }

    // The interest event was already emitted under the same lock as the inbox
    // scan in scanInboxAndMaybeEmitInterest (Sg2: one lock per hook invocation).

    process.stderr.write(
      buildSummary(overlaps) + '\nThis file overlaps with another agent\'s claimed files. Skip this edit or ask the user for guidance.'
    );
    process.exit(2);
  }

  // No file overlap — inject non-blocking context only when something changed
  otherContexts.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const parts = [buildSummary(otherContexts)];
  if (inboxText) {
    parts.push(inboxText);
  }
  const combined = parts.join('\n\n');
  const combinedHash = hashString(combined);
  const prevHash = getContextHash(collabDir, sessionId);
  if (prevHash === combinedHash) {
    process.exit(0);
  }
  setContextHash(collabDir, sessionId, combinedHash);
  allowWithAdditionalContext(combined);
}

main().catch(err => {
  process.stderr.write('[collab/guard] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
