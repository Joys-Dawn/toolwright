'use strict';

const fs = require('fs');
const path = require('path');

// User-facing config is in minutes. Internally everything is milliseconds.
const DEFAULTS_MIN = {
  PLANNED_FILE_TIMEOUT_MIN: 15,
  PLANNED_FILE_GRACE_MIN: 2,
  AUTO_TRACKED_FILE_TIMEOUT_MIN: 2,
  SESSION_HARD_SCAVENGE_MIN: 60,
  REMINDER_IDLE_MIN: 5,
  INACTIVE_THRESHOLD_MIN: 6
};

function toMs(minutes) {
  return minutes * 60 * 1000;
}

function loadConfig(cwd) {
  const configPath = path.join(cwd, '.claude', 'wrightward.json');
  let userConfig = {};
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!userConfig || typeof userConfig !== 'object' || Array.isArray(userConfig)) {
      userConfig = {};
    }
  } catch (_) {
    // Missing or invalid config file — use defaults only.
  }
  const merged = { ...DEFAULTS_MIN };
  for (const key of Object.keys(DEFAULTS_MIN)) {
    if (typeof userConfig[key] === 'number' && userConfig[key] >= 0) {
      merged[key] = userConfig[key];
    }
  }
  return Object.freeze({
    PLANNED_FILE_TIMEOUT_MS: toMs(merged.PLANNED_FILE_TIMEOUT_MIN),
    PLANNED_FILE_GRACE_MS: toMs(merged.PLANNED_FILE_GRACE_MIN),
    AUTO_TRACKED_FILE_TIMEOUT_MS: toMs(merged.AUTO_TRACKED_FILE_TIMEOUT_MIN),
    SESSION_HARD_SCAVENGE_MS: toMs(merged.SESSION_HARD_SCAVENGE_MIN),
    REMINDER_IDLE_MS: toMs(merged.REMINDER_IDLE_MIN),
    INACTIVE_THRESHOLD_MS: toMs(merged.INACTIVE_THRESHOLD_MIN)
  });
}

module.exports = { DEFAULTS_MIN, loadConfig };
