'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULTS_MIN, loadConfig } = require('../../lib/config');

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
});
