'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');
const { readMarker, writeMarker, markerPath, markerDir } = require('../../lib/last-prompt');

describe('lib/last-prompt', () => {
  let tmpDir, collabDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-prompt-test-'));
    collabDir = ensureCollabDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no marker exists', () => {
    assert.equal(readMarker(collabDir, 'sess-1'), null);
  });

  it('writes and reads a cli marker', () => {
    writeMarker(collabDir, 'sess-1', 'cli');
    const m = readMarker(collabDir, 'sess-1');
    assert.equal(m.channel, 'cli');
    assert.equal(typeof m.ts, 'number');
    assert.ok(m.ts > 0);
  });

  it('writes and reads a discord marker', () => {
    writeMarker(collabDir, 'sess-1', 'discord');
    assert.equal(readMarker(collabDir, 'sess-1').channel, 'discord');
  });

  it('overwrites an existing marker', () => {
    writeMarker(collabDir, 'sess-1', 'cli');
    writeMarker(collabDir, 'sess-1', 'discord');
    assert.equal(readMarker(collabDir, 'sess-1').channel, 'discord');
  });

  it('keeps markers per-session independent', () => {
    writeMarker(collabDir, 'sess-1', 'cli');
    writeMarker(collabDir, 'sess-2', 'discord');
    assert.equal(readMarker(collabDir, 'sess-1').channel, 'cli');
    assert.equal(readMarker(collabDir, 'sess-2').channel, 'discord');
  });

  it('throws on invalid channel', () => {
    assert.throws(() => writeMarker(collabDir, 'sess-1', 'sms'), /channel must be/);
  });

  it('returns null on corrupt JSON', () => {
    const p = markerPath(collabDir, 'sess-1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not-json{');
    assert.equal(readMarker(collabDir, 'sess-1'), null);
  });

  it('returns null on missing channel field', () => {
    const p = markerPath(collabDir, 'sess-1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ts: 123 }));
    assert.equal(readMarker(collabDir, 'sess-1'), null);
  });

  it('returns null on unknown channel value', () => {
    const p = markerPath(collabDir, 'sess-1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ channel: 'fax', ts: 123 }));
    assert.equal(readMarker(collabDir, 'sess-1'), null);
  });

  it('places markers under last-prompt subdirectory', () => {
    writeMarker(collabDir, 'sess-1', 'cli');
    assert.ok(fs.existsSync(markerDir(collabDir)));
    assert.ok(fs.existsSync(markerPath(collabDir, 'sess-1')));
  });
});
