'use strict';

const path = require('path');
const { withAgentsLock } = require('./agents');
const { readContext, writeContext, fileEntryForPath } = require('./context');

/**
 * Auto-tracks a file in the session's context and collects idle file reminders.
 * Creates a minimal context if none exists (unless AUTO_TRACK is false).
 * When AUTO_TRACK is false, files are still tracked into an existing context
 * (declared via collab-context) but no new context is created automatically.
 *
 * Reminders (suggesting the agent release idle files) only make sense when
 * other agents are active — otherwise there's nothing to unblock. When
 * `hasOtherAgents` is false, the reminder scan is skipped entirely and no
 * entries are marked as reminded.
 *
 * Returns an array of idle file paths eligible for reminder, or null.
 */
function autoTrackFile(collabDir, sessionId, cwd, tool_name, filePath, config, hasOtherAgents) {
  let reminderFiles = null;

  withAgentsLock(collabDir, () => {
    let ctx = readContext(collabDir, sessionId);
    if (!ctx) {
      if (!config.AUTO_TRACK) return;
      ctx = { task: 'Auto-tracked (no task declared)', files: [], functions: [], status: 'in-progress' };
    }

    const relative = path.relative(cwd, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const bare = relative.split(path.sep).join('/');
      const prefix = tool_name === 'Write' ? '+' : '~';
      const existingFiles = ctx.files || [];
      const existingIndex = existingFiles.findIndex(f => f.path === bare);

      if (existingIndex >= 0) {
        existingFiles[existingIndex].lastTouched = Date.now();
        existingFiles[existingIndex].reminded = false;
      } else {
        existingFiles.push(fileEntryForPath(bare, prefix, 'auto'));
      }
      ctx.files = existingFiles;
    }

    if (hasOtherAgents) {
      const now = Date.now();
      const idle = (ctx.files || []).filter(
        f => !f.reminded && f.lastTouched && (now - f.lastTouched) > config.REMINDER_IDLE_MS
      );
      if (idle.length > 0) {
        for (const f of idle) f.reminded = true;
        reminderFiles = idle.map(f => f.path);
      }
    }

    writeContext(collabDir, sessionId, ctx);
  });

  return reminderFiles;
}

module.exports = { autoTrackFile };
