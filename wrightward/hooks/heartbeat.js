#!/usr/bin/env node
'use strict';

const path = require('path');
const { updateHeartbeatInLock, getActiveAgents, withAgentsLock } = require('../lib/agents');
const { autoTrackFile } = require('../lib/auto-track');
const { ensureCollabDir, resolveCollabDir } = require('../lib/collab-dir');
const { loadConfig } = require('../lib/config');
const { scavengeExpiredSessionsInLock, scavengeExpiredFilesInLock, getAllClaimedFiles } = require('../lib/session-state');
const { validateSessionId, isWriteTool } = require('../lib/constants');
const { appendBatch } = require('../lib/bus-log');
const { compact } = require('../lib/bus-retention');
const { buildFileFreedEvents } = require('../lib/bus-query');
const { scanAndFormatInbox } = require('../lib/bus-delivery');
const busMeta = require('../lib/bus-meta');
const interestIndex = require('../lib/interest-index');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const { session_id, cwd, tool_name, tool_input } = JSON.parse(input);
  if (!session_id || !cwd) {
    process.exit(0);
  }
  validateSessionId(session_id);

  const isFileOp = isWriteTool(tool_name) && tool_input && tool_input.file_path;
  let resolved = resolveCollabDir(cwd);

  // If .claude/collab doesn't exist: create it only for Edit/Write when auto-tracking is on.
  // Non-file tools without an existing collab dir have nothing to do.
  if (!resolved) {
    const config = loadConfig(cwd);
    if (!config.ENABLED) process.exit(0);
    if (isFileOp && config.AUTO_TRACK) {
      const collabDir = ensureCollabDir(cwd);
      resolved = { root: path.resolve(cwd), collabDir };
    } else {
      process.exit(0);
    }
  }

  const { root, collabDir } = resolved;
  const config = loadConfig(root);
  if (!config.ENABLED) process.exit(0);

  // Single lock scope for the whole heartbeat: scavenge + heartbeat update +
  // bus ops run contiguously so no other session can re-claim a scavenged file
  // between steps. That lets us skip the re-check against isFileClaimedByAnySession
  // that was required when each step took its own lock.
  //
  // Each phase is wrapped in its own try/catch with a phase label so that
  // one failing step (e.g., compact) doesn't bury the others in an
  // unattributed "consolidated ops failed" line.
  const contextParts = [];
  try {
    withAgentsLock(collabDir, (token) => {
      let removedFiles = [];
      try {
        scavengeExpiredSessionsInLock(token, collabDir, config.SESSION_HARD_SCAVENGE_MS, session_id);
        removedFiles = scavengeExpiredFilesInLock(collabDir, config);
      } catch (err) {
        process.stderr.write('[collab/heartbeat] scavenge failed: ' + (err.message || err) + '\n');
      }

      try {
        updateHeartbeatInLock(collabDir, session_id);
      } catch (err) {
        process.stderr.write('[collab/heartbeat] heartbeat update failed: ' + (err.message || err) + '\n');
      }

      if (!config.BUS_ENABLED) return;

      // 1. Emit file_freed events for files scavenged above. Under one lock
      //    nothing can re-claim between scavenge and here, but the file may
      //    still be claimed by OTHER sessions (two sessions can declare the
      //    same file — scavenge only expired one of them). Skip file_freed
      //    in that case: the file isn't actually free.
      if (removedFiles.length > 0) {
        try {
          // Snapshot claims once and pass to buildFileFreedEvents so it skips
          // files still held by another session — emitting file_freed for
          // still-claimed files would mislead watchers (they'd Write and hit
          // the guard block). buildFileFreedEvents is the single source of
          // truth for this check across heartbeat, handoff, and cleanup paths.
          const stillClaimed = getAllClaimedFiles(collabDir);
          // Group by releaser so buildFileFreedEvents sees one releaser per call
          // (the releaser identity goes into the event).
          const byReleaser = new Map();
          for (const { sessionId: releasedBy, file } of removedFiles) {
            if (!byReleaser.has(releasedBy)) byReleaser.set(releasedBy, []);
            byReleaser.get(releasedBy).push(file);
          }
          const fileFreedEvents = [];
          for (const [releasedBy, files] of byReleaser) {
            fileFreedEvents.push(...buildFileFreedEvents(token, collabDir, {
              releasedBy, files, reason: 'scavenge', stillClaimed
            }));
          }
          if (fileFreedEvents.length > 0) {
            appendBatch(token, collabDir, fileFreedEvents);
          }
        } catch (err) {
          process.stderr.write('[collab/heartbeat] file_freed emission failed: ' + (err.message || err) + '\n');
        }
      }

      // 2. Bus compaction — gate on the actual event count (from bus-meta.json)
      //    rather than a byte-size heuristic. config.js guarantees a default.
      //    Also force-compact when meta.generation < 0: the readMeta corrupt-file
      //    sentinel. Without this, a corrupt bus-meta.json pins every bookmark
      //    as stale (isStale always true) and every heartbeat does a full rescan
      //    from offset 0 until eventCount crosses MAX_EVENTS — which may never
      //    happen on a quiet bus. compact() rewrites meta via onCompact and
      //    clamps the sentinel to generation >= 1.
      try {
        const meta = busMeta.readMeta(collabDir);
        if (meta.eventCount > config.BUS_RETENTION_MAX_EVENTS || meta.generation < 0) {
          compact(token, collabDir, config, (t, dir) => interestIndex.rebuild(t, dir));
        }
      } catch (err) {
        process.stderr.write('[collab/heartbeat] compaction failed: ' + (err.message || err) + '\n');
      }

      // 3. Inbox injection (PostToolUse)
      try {
        const result = scanAndFormatInbox(token, collabDir, session_id, config);
        if (result.text) {
          contextParts.push(result.text);
        }
      } catch (err) {
        process.stderr.write('[collab/heartbeat] inbox scan failed: ' + (err.message || err) + '\n');
      }
    });
  } catch (err) {
    // Only reached when withAgentsLock itself fails (e.g., lock contention
    // after max retries). Per-phase errors are already logged above.
    process.stderr.write('[collab/heartbeat] lock acquisition failed: ' + (err.message || err) + '\n');
  }

  if (isFileOp) {
    // Reminders to release idle files only make sense when other agents are
    // active — otherwise there's nobody to unblock. Check once and pass down.
    const otherAgents = getActiveAgents(collabDir, config.INACTIVE_THRESHOLD_MS);
    delete otherAgents[session_id];
    const hasOtherAgents = Object.keys(otherAgents).length > 0;
    const reminderFiles = autoTrackFile(collabDir, session_id, root, tool_name, tool_input.file_path, config, hasOtherAgents);

    if (reminderFiles && reminderFiles.length > 0) {
      const fileList = reminderFiles.join(', ');
      const idleMinutes = Math.round(config.REMINDER_IDLE_MS / 60000);
      contextParts.push(
        `You haven't touched these files in over ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}: ${fileList}. ` +
        'Consider releasing them with /wrightward:collab-release if you no longer need them.'
      );
    }
  }

  if (contextParts.length > 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'allow',
        additionalContext: contextParts.join('\n\n')
      }
    }));
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[collab/heartbeat] ' + (err.stack || err.message || err) + '\n');
  process.exit(0);
});
