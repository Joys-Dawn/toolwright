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

const DEFAULTS_BOOL = {
  ENABLED: true,
  AUTO_TRACK: true,
  BUS_ENABLED: true
};

// Bus-specific defaults — not _MIN keys; these have their own units.
const BUS_DEFAULTS = {
  BUS_RETENTION_DAYS: 7,         // days
  BUS_RETENTION_MAX_EVENTS: 10000,
  BUS_HANDOFF_TTL_MIN: 30,      // minutes
  BUS_INTEREST_TTL_MIN: 60,     // minutes
  BUS_URGENT_INJECTION_CAP: 5
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
  const bools = { ...DEFAULTS_BOOL };
  for (const key of Object.keys(DEFAULTS_BOOL)) {
    if (typeof userConfig[key] === 'boolean') {
      bools[key] = userConfig[key];
    }
  }

  // Merge bus-specific numeric defaults.
  // Floor 1 for:
  //   - BUS_URGENT_INJECTION_CAP: a cap of 0 would drop urgent events silently.
  //   - BUS_RETENTION_MAX_EVENTS: a cap of 0 causes compact() to wipe the bus
  //     on every heartbeat (surviving.slice(surviving.length - 0) = []).
  // Time-based knobs (TTL, retention days) accept 0 meaning "disabled".
  const FLOOR_ONE = new Set(['BUS_URGENT_INJECTION_CAP', 'BUS_RETENTION_MAX_EVENTS']);
  const bus = { ...BUS_DEFAULTS };
  for (const key of Object.keys(BUS_DEFAULTS)) {
    if (typeof userConfig[key] === 'number') {
      const floor = FLOOR_ONE.has(key) ? 1 : 0;
      if (userConfig[key] >= floor) {
        bus[key] = userConfig[key];
      }
    }
  }

  return Object.freeze({
    PLANNED_FILE_TIMEOUT_MS: toMs(merged.PLANNED_FILE_TIMEOUT_MIN),
    PLANNED_FILE_GRACE_MS: toMs(merged.PLANNED_FILE_GRACE_MIN),
    AUTO_TRACKED_FILE_TIMEOUT_MS: toMs(merged.AUTO_TRACKED_FILE_TIMEOUT_MIN),
    SESSION_HARD_SCAVENGE_MS: toMs(merged.SESSION_HARD_SCAVENGE_MIN),
    REMINDER_IDLE_MS: toMs(merged.REMINDER_IDLE_MIN),
    INACTIVE_THRESHOLD_MS: toMs(merged.INACTIVE_THRESHOLD_MIN),
    ENABLED: bools.ENABLED,
    AUTO_TRACK: bools.AUTO_TRACK,
    BUS_ENABLED: bools.BUS_ENABLED,
    BUS_RETENTION_DAYS_MS: bus.BUS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    BUS_RETENTION_MAX_EVENTS: bus.BUS_RETENTION_MAX_EVENTS,
    BUS_HANDOFF_TTL_MS: toMs(bus.BUS_HANDOFF_TTL_MIN),
    BUS_INTEREST_TTL_MS: toMs(bus.BUS_INTEREST_TTL_MIN),
    BUS_URGENT_INJECTION_CAP: bus.BUS_URGENT_INJECTION_CAP
  });
}

module.exports = { DEFAULTS_MIN, BUS_DEFAULTS, loadConfig };
