'use strict';

const fs = require('fs');
const path = require('path');
const { mergePolicy } = require('./mirror-policy');

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

// Phase 3 Discord bridge defaults. ENABLED defaults to false so Phase 1-2
// behavior is preserved for any user who hasn't configured Discord.
const DISCORD_DEFAULTS = {
  ENABLED: false,
  FORUM_CHANNEL_ID: null,
  BROADCAST_CHANNEL_ID: null,
  ALLOWED_SENDERS: [],
  POLL_INTERVAL_MS: 3000,
  THREAD_RENAME_ON_CONTEXT_UPDATE: true,
  BOT_USER_AGENT: null
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

  const discord = loadDiscordConfig(userConfig.discord);

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
    BUS_URGENT_INJECTION_CAP: bus.BUS_URGENT_INJECTION_CAP,
    discord
  });
}

/**
 * Loads and validates the Phase 3 `discord` config block. Unknown keys are
 * ignored; malformed values fall back to defaults. Returns a frozen object
 * so the top-level `Object.freeze(config)` propagates protection to nested
 * mutations (Object.freeze is shallow).
 */
function loadDiscordConfig(raw) {
  const out = { ...DISCORD_DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.ENABLED === 'boolean') out.ENABLED = raw.ENABLED;
    if (typeof raw.FORUM_CHANNEL_ID === 'string' && raw.FORUM_CHANNEL_ID.length > 0) {
      out.FORUM_CHANNEL_ID = raw.FORUM_CHANNEL_ID;
    }
    if (typeof raw.BROADCAST_CHANNEL_ID === 'string' && raw.BROADCAST_CHANNEL_ID.length > 0) {
      out.BROADCAST_CHANNEL_ID = raw.BROADCAST_CHANNEL_ID;
    }
    if (Array.isArray(raw.ALLOWED_SENDERS)) {
      out.ALLOWED_SENDERS = raw.ALLOWED_SENDERS.filter((s) => typeof s === 'string' && s.length > 0);
    }
    if (typeof raw.POLL_INTERVAL_MS === 'number' && raw.POLL_INTERVAL_MS >= 500) {
      out.POLL_INTERVAL_MS = raw.POLL_INTERVAL_MS;
    }
    if (typeof raw.THREAD_RENAME_ON_CONTEXT_UPDATE === 'boolean') {
      out.THREAD_RENAME_ON_CONTEXT_UPDATE = raw.THREAD_RENAME_ON_CONTEXT_UPDATE;
    }
    if (typeof raw.BOT_USER_AGENT === 'string' && raw.BOT_USER_AGENT.length > 0) {
      out.BOT_USER_AGENT = raw.BOT_USER_AGENT;
    }
  }
  // Merge user's mirrorPolicy on top of defaults. mergePolicy enforces the
  // HARD_RAIL constraints (interest/ack/delivery_failed/rate_limited cannot
  // be elevated to a mirror action).
  out.mirrorPolicy = Object.freeze(mergePolicy(raw && raw.mirrorPolicy));
  Object.freeze(out.ALLOWED_SENDERS);
  return Object.freeze(out);
}

module.exports = { DEFAULTS_MIN, BUS_DEFAULTS, DISCORD_DEFAULTS, loadConfig, loadDiscordConfig };
