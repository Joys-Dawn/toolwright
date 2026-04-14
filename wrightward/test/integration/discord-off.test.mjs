// Integration: proves zero bridge-related side effects when the Discord
// bridge is disabled.
//
// Phase 3 adds `.claude/collab/bridge/` state (lockfile, bridge.log, circuit
// breaker). Users who never configure Discord must see identical Phase 1-2
// behavior — no directories created, no lockfile, no child process.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { tryAcquireAndSpawn } from '../../broker/bridge-spawn.mjs';
import { bridgeDir, lockPath, logPath, circuitPath } from '../../broker/lifecycle.mjs';

const require = createRequire(import.meta.url);
const { ensureCollabDir } = require('../../lib/collab-dir');
const { loadConfig } = require('../../lib/config');

describe('integration: bridge disabled', () => {
  let tmpDir, collabDir, claudeDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-off-'));
    collabDir = ensureCollabDir(tmpDir);
    claudeDir = path.join(tmpDir, '.claude');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('tryAcquireAndSpawn short-circuits with discord_disabled when ENABLED=false', () => {
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({
      discord: { ENABLED: false }
    }));
    const config = loadConfig(tmpDir);
    assert.equal(config.discord.ENABLED, false);

    const r = tryAcquireAndSpawn(collabDir, {
      sessionId: 'sess-a',
      discordEnabled: config.discord.ENABLED,
      busEnabled: config.BUS_ENABLED,
      botToken: 'has-a-token-but-disabled'
    });
    assert.equal(r.running, false);
    assert.equal(r.reason, 'discord_disabled');
    assert.equal(r.childPid, null);
  });

  it('does not create the .claude/collab/bridge/ directory when disabled', () => {
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({
      discord: { ENABLED: false }
    }));
    const config = loadConfig(tmpDir);

    tryAcquireAndSpawn(collabDir, {
      sessionId: 'sess-a',
      discordEnabled: config.discord.ENABLED,
      busEnabled: config.BUS_ENABLED,
      botToken: 'tok'
    });

    assert.equal(fs.existsSync(bridgeDir(collabDir)), false,
      'bridge/ directory must not exist when discord is disabled');
    assert.equal(fs.existsSync(lockPath(collabDir)), false);
    assert.equal(fs.existsSync(logPath(collabDir)), false);
    assert.equal(fs.existsSync(circuitPath(collabDir)), false);
  });

  it('short-circuits with no_token when discord is enabled but token is absent', () => {
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({
      discord: {
        ENABLED: true,
        FORUM_CHANNEL_ID: 'f',
        BROADCAST_CHANNEL_ID: 'b',
        ALLOWED_SENDERS: []
      }
    }));
    const config = loadConfig(tmpDir);

    const r = tryAcquireAndSpawn(collabDir, {
      sessionId: 'sess-a',
      discordEnabled: config.discord.ENABLED,
      busEnabled: config.BUS_ENABLED,
      botToken: null
    });
    assert.equal(r.reason, 'no_token');
    assert.equal(fs.existsSync(bridgeDir(collabDir)), false,
      'no bridge/ should be created on no_token either');
  });

  it('short-circuits with bus_disabled when BUS_ENABLED=false takes precedence', () => {
    fs.writeFileSync(path.join(claudeDir, 'wrightward.json'), JSON.stringify({
      BUS_ENABLED: false,
      discord: { ENABLED: true }
    }));
    const config = loadConfig(tmpDir);
    assert.equal(config.BUS_ENABLED, false);

    const r = tryAcquireAndSpawn(collabDir, {
      sessionId: 'sess-a',
      discordEnabled: config.discord.ENABLED,
      busEnabled: config.BUS_ENABLED,
      botToken: 'tok'
    });
    assert.equal(r.reason, 'bus_disabled');
    assert.equal(fs.existsSync(bridgeDir(collabDir)), false);
  });

  it('returns default discord.ENABLED=false when no discord section configured', () => {
    // Completely empty wrightward.json (or missing entirely). Phase 1-2
    // users see no bridge machinery at all.
    const config = loadConfig(tmpDir);
    assert.equal(config.discord.ENABLED, false);
    const r = tryAcquireAndSpawn(collabDir, {
      sessionId: 'sess-a',
      discordEnabled: config.discord.ENABLED,
      busEnabled: config.BUS_ENABLED,
      botToken: null
    });
    assert.equal(r.reason, 'discord_disabled');
  });
});
