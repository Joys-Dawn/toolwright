'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson, atomicWriteText } = require('../../lib/atomic-write');

describe('atomicWriteJson', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pretty-prints with 2-space indent', () => {
    // bus-compact/bus-retention rewrites bus.jsonl content via atomicWriteText;
    // bookmark readers rely on the 2-space indent being consistent so snapshot
    // diffs stay readable. Not just cosmetic — it's a documented convention.
    const target = path.join(tmpDir, 'pretty.json');
    atomicWriteJson(target, { a: 1 });
    const raw = fs.readFileSync(target, 'utf8');
    assert.match(raw, /\{\n  "a": 1\n\}/);
  });

  it('roundtrips null', () => {
    const target = path.join(tmpDir, 'null.json');
    atomicWriteJson(target, null);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')), null);
  });

  it('roundtrips nested structures', () => {
    const target = path.join(tmpDir, 'nested.json');
    const data = { a: [1, 2, { b: 'x' }], c: { d: null } };
    atomicWriteJson(target, data);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), data);
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

describe('atomicWriteText', () => {
  // atomicWriteText underpins atomicWriteJson AND the Phase 3 bridge lockfile
  // writes — the pre-existing atomicWriteJson tests covered the JSON path;
  // these cover the text path that lifecycle.js will rely on directly.
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-text-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes text content to a new file', () => {
    const target = path.join(tmpDir, 'out.txt');
    atomicWriteText(target, 'hello world');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello world');
  });

  it('overwrites an existing text file', () => {
    const target = path.join(tmpDir, 'out.txt');
    atomicWriteText(target, 'v1');
    atomicWriteText(target, 'v2');
    assert.equal(fs.readFileSync(target, 'utf8'), 'v2');
  });

  it('handles empty content', () => {
    const target = path.join(tmpDir, 'empty.txt');
    atomicWriteText(target, '');
    assert.equal(fs.readFileSync(target, 'utf8'), '');
  });

  it('preserves UTF-8 multi-byte characters', () => {
    const target = path.join(tmpDir, 'utf8.txt');
    atomicWriteText(target, 'héllo 😀 한');
    assert.equal(fs.readFileSync(target, 'utf8'), 'héllo 😀 한');
  });

  it('handles large content (2 MB)', () => {
    // Bridge log rotation triggers around 1 MB; confirm we can cross that.
    const target = path.join(tmpDir, 'big.txt');
    const big = 'x'.repeat(2 * 1024 * 1024);
    atomicWriteText(target, big);
    assert.equal(fs.statSync(target).size, big.length);
  });

  it('creates parent directories recursively', () => {
    const target = path.join(tmpDir, 'a', 'b', 'c', 'out.txt');
    atomicWriteText(target, 'nested');
    assert.equal(fs.readFileSync(target, 'utf8'), 'nested');
  });

  it('leaves no tmp file after successful write', () => {
    const target = path.join(tmpDir, 'out.txt');
    atomicWriteText(target, 'done');
    const tmps = fs.readdirSync(tmpDir).filter(name => name.includes('.tmp'));
    assert.deepEqual(tmps, []);
  });

  it('uses per-pid tmp suffix to avoid cross-process collision', () => {
    // Concurrent writes from different processes must not step on each other's
    // tmp file. The implementation encodes process.pid in the tmp filename.
    const target = path.join(tmpDir, 'check.txt');
    const origWrite = fs.writeFileSync;
    let capturedTmp = null;
    fs.writeFileSync = function (p, c, enc) {
      capturedTmp = p;
      return origWrite.call(fs, p, c, enc);
    };
    try {
      atomicWriteText(target, 'y');
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.ok(capturedTmp);
    assert.ok(capturedTmp.includes('.' + process.pid + '.tmp'),
      'tmp path must include process pid, got: ' + capturedTmp);
  });

  it('retries rename on EPERM (Windows fs.watch / AV hold), then succeeds', () => {
    // On Windows, fs.watch and AV scanners briefly hold the target file;
    // the first rename often fails with EPERM. The helper retries up to 3×.
    const target = path.join(tmpDir, 'retry.txt');
    const origRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function (from, to) {
      attempts++;
      if (attempts < 3) {
        const err = new Error('simulated EPERM');
        err.code = 'EPERM';
        throw err;
      }
      return origRename.call(fs, from, to);
    };
    try {
      atomicWriteText(target, 'eventually');
    } finally {
      fs.renameSync = origRename;
    }
    assert.equal(attempts, 3, 'expected 3 attempts (2 EPERM + 1 success)');
    assert.equal(fs.readFileSync(target, 'utf8'), 'eventually');
    // No tmp leak after eventual success
    const tmps = fs.readdirSync(tmpDir).filter(name => name.includes('.tmp'));
    assert.deepEqual(tmps, []);
  });

  it('does NOT retry on non-EPERM rename failures', () => {
    const target = path.join(tmpDir, 'noretry.txt');
    const origRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function () {
      attempts++;
      const err = new Error('simulated ENOSPC');
      err.code = 'ENOSPC';
      throw err;
    };
    try {
      assert.throws(() => atomicWriteText(target, 'x'), /ENOSPC/);
    } finally {
      fs.renameSync = origRename;
    }
    assert.equal(attempts, 1, 'non-EPERM errors must not trigger retry');
    const tmps = fs.readdirSync(tmpDir).filter(name => name.includes('.tmp'));
    assert.deepEqual(tmps, [], 'tmp file must be cleaned up on failure');
  });

  it('gives up after 3 EPERM attempts, rethrows, and cleans up tmp', () => {
    const target = path.join(tmpDir, 'gaveup.txt');
    const origRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function () {
      attempts++;
      const err = new Error('sustained EPERM');
      err.code = 'EPERM';
      throw err;
    };
    try {
      assert.throws(() => atomicWriteText(target, 'x'), /EPERM/);
    } finally {
      fs.renameSync = origRename;
    }
    assert.equal(attempts, 3, 'expected exactly 3 attempts before giving up');
    const tmps = fs.readdirSync(tmpDir).filter(name => name.includes('.tmp'));
    assert.deepEqual(tmps, []);
  });
});
