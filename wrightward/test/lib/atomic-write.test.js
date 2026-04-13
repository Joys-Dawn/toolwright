'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson } = require('../../lib/atomic-write');

describe('atomicWriteJson', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes serialized JSON to the target path', () => {
    const target = path.join(tmpDir, 'out.json');
    atomicWriteJson(target, { hello: 'world', n: 42 });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(parsed, { hello: 'world', n: 42 });
  });

  it('creates parent directories recursively', () => {
    const target = path.join(tmpDir, 'a', 'b', 'c', 'out.json');
    atomicWriteJson(target, { ok: true });
    assert.ok(fs.existsSync(target));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).ok, true);
  });

  it('overwrites an existing file with new content', () => {
    const target = path.join(tmpDir, 'out.json');
    atomicWriteJson(target, { v: 1 });
    atomicWriteJson(target, { v: 2 });
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).v, 2);
  });

  it('does not leave a .tmp file after successful write', () => {
    const target = path.join(tmpDir, 'out.json');
    atomicWriteJson(target, { x: 1 });
    const files = fs.readdirSync(tmpDir);
    // Only 'out.json' should exist — no <target>.<pid>.tmp siblings
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });

  it('cleans up the temp file and rethrows when rename fails', () => {
    const target = path.join(tmpDir, 'out.json');
    const origRename = fs.renameSync;
    const failure = new Error('simulated rename failure');
    fs.renameSync = () => { throw failure; };
    try {
      assert.throws(() => atomicWriteJson(target, { x: 1 }), /simulated rename failure/);
    } finally {
      fs.renameSync = origRename;
    }
    // Target never got written
    assert.ok(!fs.existsSync(target));
    // Temp file must not leak
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });

  it('throws on non-serializable data without writing a partial file', () => {
    const target = path.join(tmpDir, 'out.json');
    const circular = {};
    circular.self = circular;
    assert.throws(() => atomicWriteJson(target, circular));
    assert.ok(!fs.existsSync(target));
  });
});
