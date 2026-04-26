'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/log-store');

describe('log-store', () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gripewright-store-'));
    logFile = path.join(tmpDir, 'log.ndjson');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readAllRecords', () => {
    it('returns empty array when file missing', () => {
      assert.deepEqual(store.readAllRecords({ logFile }), []);
    });

    it('parses one record per line', () => {
      fs.writeFileSync(logFile, '{"a":1}\n{"a":2}\n');
      const records = store.readAllRecords({ logFile });
      assert.deepEqual(records, [{ a: 1 }, { a: 2 }]);
    });

    it('skips malformed lines', () => {
      fs.writeFileSync(logFile, '{"a":1}\nnot-json\n{"a":3}\n');
      assert.deepEqual(store.readAllRecords({ logFile }), [{ a: 1 }, { a: 3 }]);
    });

    it('skips empty lines', () => {
      fs.writeFileSync(logFile, '{"a":1}\n\n{"a":2}\n\n');
      assert.deepEqual(store.readAllRecords({ logFile }), [{ a: 1 }, { a: 2 }]);
    });
  });

  describe('appendRecord', () => {
    it('creates parent directory and writes first record', () => {
      const nested = path.join(tmpDir, 'sub', 'log.ndjson');
      store.appendRecord({ a: 1 }, { logFile: nested });
      assert.equal(fs.readFileSync(nested, 'utf8'), '{"a":1}\n');
    });

    it('appends to existing file without truncating', () => {
      store.appendRecord({ a: 1 }, { logFile });
      store.appendRecord({ a: 2 }, { logFile });
      assert.equal(fs.readFileSync(logFile, 'utf8'), '{"a":1}\n{"a":2}\n');
    });
  });

  describe('rewriteAllRecords', () => {
    it('replaces file contents atomically', () => {
      fs.writeFileSync(logFile, '{"a":1}\n{"a":2}\n{"a":3}\n');
      store.rewriteAllRecords([{ a: 1 }, { a: 2, modified: true }, { a: 3 }], { logFile });
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
      assert.deepEqual(JSON.parse(lines[1]), { a: 2, modified: true });
      assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
      assert.deepEqual(JSON.parse(lines[2]), { a: 3 });
    });

    it('removes tmp file after rename', () => {
      store.rewriteAllRecords([{ a: 1 }], { logFile });
      const dirEntries = fs.readdirSync(tmpDir);
      assert.deepEqual(dirEntries, ['log.ndjson']);
    });

    it('writes empty file when records is empty', () => {
      fs.writeFileSync(logFile, '{"old":true}\n');
      store.rewriteAllRecords([], { logFile });
      assert.equal(fs.readFileSync(logFile, 'utf8'), '');
    });

    it('does not corrupt file if write succeeds', () => {
      const records = [];
      for (let i = 0; i < 100; i++) records.push({ i, payload: 'x'.repeat(50) });
      store.rewriteAllRecords(records, { logFile });
      const read = store.readAllRecords({ logFile });
      assert.equal(read.length, 100);
      assert.equal(read[42].i, 42);
    });
  });

  describe('defaultLogFile', () => {
    it('points to ~/.claude/gripewright/log.ndjson', () => {
      const expected = path.join(os.homedir(), '.claude', 'gripewright', 'log.ndjson');
      assert.equal(store.defaultLogFile(), expected);
    });
  });

  describe('withLogLock', () => {
    it('holds the lock file for the duration of fn', () => {
      const lockFile = logFile + '.lock';
      let lockedDuringFn = false;
      store.withLogLock(logFile, () => {
        lockedDuringFn = fs.existsSync(lockFile);
      });
      assert.equal(lockedDuringFn, true, 'lock file should exist while fn runs');
      assert.equal(fs.existsSync(lockFile), false, 'lock should be released after fn returns');
    });

    it('clears stale lock files older than the stale threshold', () => {
      const lockFile = logFile + '.lock';
      // Simulate a crashed holder by creating an old lock file.
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, '99999');
      const past = new Date(Date.now() - 10_000);
      fs.utimesSync(lockFile, past, past);

      let ran = false;
      store.withLogLock(logFile, () => { ran = true; });

      assert.equal(ran, true);
      assert.equal(fs.existsSync(lockFile), false);
    });

    it('cleans up the lock file even when fn throws', () => {
      const lockFile = logFile + '.lock';
      assert.throws(() => {
        store.withLogLock(logFile, () => { throw new Error('boom'); });
      }, /boom/);
      assert.equal(fs.existsSync(lockFile), false);
    });

    it('returns the value returned by fn', () => {
      const result = store.withLogLock(logFile, () => 'hello');
      assert.equal(result, 'hello');
    });

    it('cross-process exclusion: blocks until a child holding the lock releases', async () => {
      // Spawn a child that grabs the lock, holds it ~200ms, then releases.
      // The parent's acquire attempt should block until the child releases,
      // giving an elapsed time >= the child's hold window.
      const { spawn } = require('child_process');
      const childScript = `
        const store = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib', 'log-store.js'))});
        store.withLogLock(${JSON.stringify(logFile)}, () => {
          const start = Date.now();
          while (Date.now() - start < 200) {}
        });
      `;
      const child = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore' });

      // Wait briefly so the child wins the lock first.
      await new Promise(r => setTimeout(r, 50));

      const t0 = Date.now();
      store.withLogLock(logFile, () => {});
      const elapsed = Date.now() - t0;

      await new Promise((r) => child.on('exit', r));

      assert.ok(elapsed >= 100, `parent acquired immediately (elapsed=${elapsed}ms); lock not enforced cross-process`);
    });
  });

  describe('atomicWriteText EPERM retry', () => {
    it('retries on EPERM and succeeds when next rename works', (t) => {
      const target = path.join(tmpDir, 'retry-target.txt');
      const originalRename = fs.renameSync;
      let calls = 0;
      t.mock.method(fs, 'renameSync', (...args) => {
        calls++;
        if (calls === 1) {
          const err = new Error('rename blocked by virus scanner');
          err.code = 'EPERM';
          throw err;
        }
        return originalRename.apply(fs, args);
      });

      store.atomicWriteText(target, 'hello after retry');

      assert.equal(calls, 2);
      assert.equal(fs.readFileSync(target, 'utf8'), 'hello after retry');
    });

    it('throws EPERM after 3 attempts and cleans up tmp file', (t) => {
      const target = path.join(tmpDir, 'always-fail.txt');
      let calls = 0;
      t.mock.method(fs, 'renameSync', () => {
        calls++;
        const err = new Error('rename blocked');
        err.code = 'EPERM';
        throw err;
      });

      assert.throws(
        () => store.atomicWriteText(target, 'doomed'),
        (err) => err.code === 'EPERM',
      );
      assert.equal(calls, 3);
      const leftovers = fs.readdirSync(tmpDir).filter(n => n.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    });

    it('does not retry on non-EPERM error', (t) => {
      const target = path.join(tmpDir, 'non-eperm.txt');
      let calls = 0;
      t.mock.method(fs, 'renameSync', () => {
        calls++;
        const err = new Error('access denied');
        err.code = 'EACCES';
        throw err;
      });

      assert.throws(
        () => store.atomicWriteText(target, 'doomed'),
        (err) => err.code === 'EACCES',
      );
      assert.equal(calls, 1);
      const leftovers = fs.readdirSync(tmpDir).filter(n => n.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    });

    it('does not write target file when all retries fail', (t) => {
      const target = path.join(tmpDir, 'untouched.txt');
      t.mock.method(fs, 'renameSync', () => {
        const err = new Error('blocked');
        err.code = 'EPERM';
        throw err;
      });

      assert.throws(() => store.atomicWriteText(target, 'doomed'));
      assert.equal(fs.existsSync(target), false);
    });
  });
});
