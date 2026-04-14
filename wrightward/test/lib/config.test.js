'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULTS_MIN, BUS_DEFAULTS, DISCORD_DEFAULTS, loadConfig } = require('../../lib/config');

describe('config', () => {
  let cwd;
  let configPath;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cfg-'));
    const claudeDir = path.join(cwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    configPath = path.join(claudeDir, 'wrightward.json');
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns defaults converted to ms when no config file exists', () => {
    const config = loadConfig(cwd);
    assert.equal(config.PLANNED_FILE_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(config.PLANNED_FILE_GRACE_MS, 2 * 60 * 1000);
    assert.equal(config.AUTO_TRACKED_FILE_TIMEOUT_MS, 2 * 60 * 1000);
    assert.equal(config.SESSION_HARD_SCAVENGE_MS, 60 * 60 * 1000);
    assert.equal(config.REMINDER_IDLE_MS, 5 * 60 * 1000);
    assert.equal(config.INACTIVE_THRESHOLD_MS, 6 * 60 * 1000);
  });

  it('converts user minutes to ms', () => {
    fs.writeFileSync(configPath, JSON.stringify({ PLANNED_FILE_TIMEOUT_MIN: 10 }));
    const config = loadConfig(cwd);
    assert.equal(config.PLANNED_FILE_TIMEOUT_MS, 10 * 60 * 1000);
    assert.equal(config.PLANNED_FILE_GRACE_MS, DEFAULTS_MIN.PLANNED_FILE_GRACE_MIN * 60 * 1000);
  });

  it('ignores unknown keys from user config', () => {
    fs.writeFileSync(configPath, JSON.stringify({ UNKNOWN_KEY: 999 }));
    const config = loadConfig(cwd);
    assert.equal(config.UNKNOWN_KEY, undefined);
  });

  it('ignores non-numeric values for known keys', () => {
    fs.writeFileSync(configPath, JSON.stringify({ PLANNED_FILE_TIMEOUT_MIN: 'not a number' }));
    const config = loadConfig(cwd);
    assert.equal(config.PLANNED_FILE_TIMEOUT_MS, 15 * 60 * 1000);
  });

  it('ignores negative values', () => {
    fs.writeFileSync(configPath, JSON.stringify({ PLANNED_FILE_TIMEOUT_MIN: -5 }));
    const config = loadConfig(cwd);
    assert.equal(config.PLANNED_FILE_TIMEOUT_MS, 15 * 60 * 1000);
  });

  it('returns defaults for invalid JSON', () => {
    fs.writeFileSync(configPath, 'not json');
    const config = loadConfig(cwd);
    assert.equal(config.PLANNED_FILE_TIMEOUT_MS, 15 * 60 * 1000);
  });

  it('returns defaults for array JSON', () => {
    fs.writeFileSync(configPath, '[1,2,3]');
    const config = loadConfig(cwd);
    assert.equal(config.PLANNED_FILE_TIMEOUT_MS, 15 * 60 * 1000);
  });

  it('returns a frozen object', () => {
    const config = loadConfig(cwd);
    assert.ok(Object.isFrozen(config));
  });

  it('allows zero as a valid override', () => {
    fs.writeFileSync(configPath, JSON.stringify({ REMINDER_IDLE_MIN: 0 }));
    const config = loadConfig(cwd);
    assert.equal(config.REMINDER_IDLE_MS, 0);
  });

  it('defaults AUTO_TRACK to true', () => {
    const config = loadConfig(cwd);
    assert.equal(config.AUTO_TRACK, true);
  });

  it('allows AUTO_TRACK to be set to false', () => {
    fs.writeFileSync(configPath, JSON.stringify({ AUTO_TRACK: false }));
    const config = loadConfig(cwd);
    assert.equal(config.AUTO_TRACK, false);
  });

  it('ignores non-boolean AUTO_TRACK values', () => {
    fs.writeFileSync(configPath, JSON.stringify({ AUTO_TRACK: 'yes' }));
    const config = loadConfig(cwd);
    assert.equal(config.AUTO_TRACK, true);
  });

  it('defaults ENABLED to true', () => {
    const config = loadConfig(cwd);
    assert.equal(config.ENABLED, true);
  });

  it('allows ENABLED to be set to false', () => {
    fs.writeFileSync(configPath, JSON.stringify({ ENABLED: false }));
    const config = loadConfig(cwd);
    assert.equal(config.ENABLED, false);
  });

  it('ignores non-boolean ENABLED values', () => {
    fs.writeFileSync(configPath, JSON.stringify({ ENABLED: 0 }));
    const config = loadConfig(cwd);
    assert.equal(config.ENABLED, true);
  });

  // Bus config tests
  it('defaults BUS_ENABLED to true', () => {
    const config = loadConfig(cwd);
    assert.equal(config.BUS_ENABLED, true);
  });

  it('allows BUS_ENABLED to be set to false', () => {
    fs.writeFileSync(configPath, JSON.stringify({ BUS_ENABLED: false }));
    const config = loadConfig(cwd);
    assert.equal(config.BUS_ENABLED, false);
  });

  it('has correct bus retention defaults', () => {
    const config = loadConfig(cwd);
    assert.equal(config.BUS_RETENTION_DAYS_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(config.BUS_RETENTION_MAX_EVENTS, 10000);
    assert.equal(config.BUS_HANDOFF_TTL_MS, 30 * 60 * 1000);
    assert.equal(config.BUS_INTEREST_TTL_MS, 60 * 60 * 1000);
    assert.equal(config.BUS_URGENT_INJECTION_CAP, 5);
  });

  it('overrides bus numeric values from user config', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      BUS_RETENTION_DAYS: 3,
      BUS_RETENTION_MAX_EVENTS: 500
    }));
    const config = loadConfig(cwd);
    assert.equal(config.BUS_RETENTION_DAYS_MS, 3 * 24 * 60 * 60 * 1000);
    assert.equal(config.BUS_RETENTION_MAX_EVENTS, 500);
  });

  it('ignores negative bus values', () => {
    fs.writeFileSync(configPath, JSON.stringify({ BUS_RETENTION_DAYS: -1 }));
    const config = loadConfig(cwd);
    assert.equal(config.BUS_RETENTION_DAYS_MS, 7 * 24 * 60 * 60 * 1000);
  });

  describe('bus floor-1 keys reject 0', () => {
    it('rejects BUS_URGENT_INJECTION_CAP: 0 (cap of 0 would drop urgent events)', () => {
      fs.writeFileSync(configPath, JSON.stringify({ BUS_URGENT_INJECTION_CAP: 0 }));
      const config = loadConfig(cwd);
      assert.equal(config.BUS_URGENT_INJECTION_CAP, BUS_DEFAULTS.BUS_URGENT_INJECTION_CAP,
        'falls back to default');
    });

    it('accepts BUS_URGENT_INJECTION_CAP: 1', () => {
      fs.writeFileSync(configPath, JSON.stringify({ BUS_URGENT_INJECTION_CAP: 1 }));
      assert.equal(loadConfig(cwd).BUS_URGENT_INJECTION_CAP, 1);
    });

    it('rejects BUS_RETENTION_MAX_EVENTS: 0 (would wipe bus every compaction)', () => {
      fs.writeFileSync(configPath, JSON.stringify({ BUS_RETENTION_MAX_EVENTS: 0 }));
      assert.equal(loadConfig(cwd).BUS_RETENTION_MAX_EVENTS,
        BUS_DEFAULTS.BUS_RETENTION_MAX_EVENTS);
    });

    it('accepts BUS_RETENTION_MAX_EVENTS: 1', () => {
      fs.writeFileSync(configPath, JSON.stringify({ BUS_RETENTION_MAX_EVENTS: 1 }));
      assert.equal(loadConfig(cwd).BUS_RETENTION_MAX_EVENTS, 1);
    });

    it('still accepts 0 for TTL-style keys (floor remains 0)', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        BUS_HANDOFF_TTL_MIN: 0,
        BUS_INTEREST_TTL_MIN: 0,
        BUS_RETENTION_DAYS: 0
      }));
      const config = loadConfig(cwd);
      assert.equal(config.BUS_HANDOFF_TTL_MS, 0);
      assert.equal(config.BUS_INTEREST_TTL_MS, 0);
      assert.equal(config.BUS_RETENTION_DAYS_MS, 0);
    });
  });

  describe('discord section', () => {
    it('exposes a discord sub-object with ENABLED=false by default', () => {
      const config = loadConfig(cwd);
      assert.ok(config.discord, 'discord sub-object must exist');
      assert.equal(config.discord.ENABLED, false);
      assert.equal(config.discord.FORUM_CHANNEL_ID, null);
      assert.equal(config.discord.BROADCAST_CHANNEL_ID, null);
      assert.deepEqual(config.discord.ALLOWED_SENDERS, []);
      assert.equal(config.discord.POLL_INTERVAL_MS, DISCORD_DEFAULTS.POLL_INTERVAL_MS);
      assert.equal(config.discord.THREAD_RENAME_ON_CONTEXT_UPDATE, true);
      assert.equal(config.discord.BOT_USER_AGENT, null);
    });

    it('parses every known discord field from user config', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        discord: {
          ENABLED: true,
          FORUM_CHANNEL_ID: '111',
          BROADCAST_CHANNEL_ID: '222',
          ALLOWED_SENDERS: ['u1', 'u2'],
          POLL_INTERVAL_MS: 5000,
          THREAD_RENAME_ON_CONTEXT_UPDATE: false,
          BOT_USER_AGENT: 'DiscordBot (https://example.com, 1.0.0)'
        }
      }));
      const config = loadConfig(cwd);
      assert.equal(config.discord.ENABLED, true);
      assert.equal(config.discord.FORUM_CHANNEL_ID, '111');
      assert.equal(config.discord.BROADCAST_CHANNEL_ID, '222');
      assert.deepEqual(config.discord.ALLOWED_SENDERS, ['u1', 'u2']);
      assert.equal(config.discord.POLL_INTERVAL_MS, 5000);
      assert.equal(config.discord.THREAD_RENAME_ON_CONTEXT_UPDATE, false);
      assert.equal(config.discord.BOT_USER_AGENT, 'DiscordBot (https://example.com, 1.0.0)');
    });

    it('ignores malformed field values and falls back to defaults', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        discord: {
          ENABLED: 'yes',                        // not boolean
          FORUM_CHANNEL_ID: '',                  // empty string
          BROADCAST_CHANNEL_ID: 12345,           // not string
          ALLOWED_SENDERS: 'u1',                 // not array
          POLL_INTERVAL_MS: 100,                 // under 500ms floor
          THREAD_RENAME_ON_CONTEXT_UPDATE: 1,    // not boolean
          BOT_USER_AGENT: ''                     // empty string
        }
      }));
      const config = loadConfig(cwd);
      assert.equal(config.discord.ENABLED, false);
      assert.equal(config.discord.FORUM_CHANNEL_ID, null);
      assert.equal(config.discord.BROADCAST_CHANNEL_ID, null);
      assert.deepEqual(config.discord.ALLOWED_SENDERS, []);
      assert.equal(config.discord.POLL_INTERVAL_MS, DISCORD_DEFAULTS.POLL_INTERVAL_MS);
      assert.equal(config.discord.THREAD_RENAME_ON_CONTEXT_UPDATE, true);
      assert.equal(config.discord.BOT_USER_AGENT, null);
    });

    it('filters non-string entries out of ALLOWED_SENDERS', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        discord: { ALLOWED_SENDERS: ['u1', 42, '', 'u2', null] }
      }));
      const config = loadConfig(cwd);
      assert.deepEqual(config.discord.ALLOWED_SENDERS, ['u1', 'u2']);
    });

    it('treats non-object discord value as absent', () => {
      fs.writeFileSync(configPath, JSON.stringify({ discord: ['not an object'] }));
      const config = loadConfig(cwd);
      assert.equal(config.discord.ENABLED, false);
    });

    it('deep-freezes the discord sub-object and its ALLOWED_SENDERS', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        discord: { ENABLED: true, ALLOWED_SENDERS: ['u1'] }
      }));
      const config = loadConfig(cwd);
      assert.ok(Object.isFrozen(config.discord));
      assert.ok(Object.isFrozen(config.discord.ALLOWED_SENDERS));
      assert.ok(Object.isFrozen(config.discord.mirrorPolicy));
    });

    it('exposes a default mirror policy with mirror actions and silent/never rules', () => {
      const config = loadConfig(cwd);
      const p = config.discord.mirrorPolicy;
      assert.equal(p.user_message.action, 'post_thread');
      assert.equal(p.handoff.action, 'post_thread');
      assert.equal(p.session_started.action, 'post_broadcast');
      assert.equal(p.note.action, 'silent');
      assert.equal(p.interest.action, 'never');
      assert.equal(p.ack.action, 'never');
      assert.equal(p.delivery_failed.action, 'never');
      assert.equal(p.rate_limited.action, 'never');
    });

    it('merges a user mirrorPolicy override on top of defaults', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        discord: {
          mirrorPolicy: { note: { action: 'post_broadcast' } }
        }
      }));
      const config = loadConfig(cwd);
      assert.equal(config.discord.mirrorPolicy.note.action, 'post_broadcast');
      // Unrelated defaults remain intact.
      assert.equal(config.discord.mirrorPolicy.handoff.action, 'post_thread');
    });

    it('accepts POLL_INTERVAL_MS exactly at the 500ms floor (boundary)', () => {
      // Guard against an off-by-one where `> 500` would silently drop legal
      // configurations. Spec says "≥ 500" so exactly 500 is accepted.
      fs.writeFileSync(configPath, JSON.stringify({
        discord: { POLL_INTERVAL_MS: 500 }
      }));
      const config = loadConfig(cwd);
      assert.equal(config.discord.POLL_INTERVAL_MS, 500);
    });

    it('hard rail: user cannot elevate interest/ack/delivery_failed/rate_limited to a mirror action', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        discord: {
          mirrorPolicy: {
            interest: { action: 'post_broadcast' },
            ack: { action: 'post_thread' },
            delivery_failed: { action: 'post_broadcast' },
            rate_limited: { action: 'post_thread' }
          }
        }
      }));
      const config = loadConfig(cwd);
      assert.equal(config.discord.mirrorPolicy.interest.action, 'never');
      assert.equal(config.discord.mirrorPolicy.ack.action, 'never');
      assert.equal(config.discord.mirrorPolicy.delivery_failed.action, 'never');
      assert.equal(config.discord.mirrorPolicy.rate_limited.action, 'never');
    });
  });
});
