'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeJson, readJson, appendJsonLine, removePath } = require('../../coordinator/io');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-io-'));
}

describe('coordinator/io', () => {
  describe('writeJson', () => {
    test('writes valid pretty-printed JSON', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'sub', 'state.json');
        writeJson(file, { a: 1, b: [2, 3] });
        const raw = fs.readFileSync(file, 'utf8');
        assert.deepEqual(JSON.parse(raw), { a: 1, b: [2, 3] });
        // pretty-printed: contains a newline
        assert.match(raw, /\n/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('creates parent directories', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'a', 'b', 'c', 'nested.json');
        writeJson(file, { ok: true });
        assert.ok(fs.existsSync(file));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('atomic via tmp+rename — no .tmp leak after success', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'state.json');
        writeJson(file, { v: 1 });
        const remaining = fs.readdirSync(dir);
        assert.deepEqual(remaining, ['state.json'], 'tmp file must not survive a successful write');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('overwrites an existing file', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'state.json');
        writeJson(file, { v: 1 });
        writeJson(file, { v: 2 });
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('retries fs.renameSync on transient EPERM then succeeds (Windows AV/indexer race)', () => {
      const dir = tmpDir();
      const origRename = fs.renameSync;
      let attempts = 0;
      try {
        const file = path.join(dir, 'state.json');
        fs.renameSync = function (src, dst) {
          attempts++;
          if (attempts < 3) {
            const err = new Error('simulated EPERM');
            err.code = 'EPERM';
            throw err;
          }
          return origRename.call(this, src, dst);
        };

        writeJson(file, { v: 'retried' });
        assert.equal(attempts, 3, 'must have retried twice before the success on the third attempt');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 'retried' });
        // No tmp file leak after success.
        const remaining = fs.readdirSync(dir);
        assert.deepEqual(remaining, ['state.json']);
      } finally {
        fs.renameSync = origRename;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('throws immediately on non-retriable rename errors (e.g. EISDIR) and cleans up the tmp file', () => {
      const dir = tmpDir();
      const origRename = fs.renameSync;
      let attempts = 0;
      try {
        const file = path.join(dir, 'state.json');
        fs.renameSync = function () {
          attempts++;
          const err = new Error('simulated EISDIR');
          err.code = 'EISDIR';
          throw err;
        };

        assert.throws(
          () => writeJson(file, { v: 'should-not-land' }),
          err => err.code === 'EISDIR',
        );
        assert.equal(attempts, 1, 'non-retriable errors must NOT trigger the retry loop');
        // tmp file must be cleaned up — directory should be empty.
        const remaining = fs.readdirSync(dir);
        assert.deepEqual(remaining, [], 'tmp file must be unlinked when rename fails non-retriably');
      } finally {
        fs.renameSync = origRename;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('readJson', () => {
    test('returns fallback when file is missing', () => {
      const dir = tmpDir();
      try {
        assert.equal(readJson(path.join(dir, 'missing.json')), null);
        assert.deepEqual(readJson(path.join(dir, 'missing.json'), { default: true }), { default: true });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('parses valid JSON', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'data.json');
        fs.writeFileSync(file, '{"k":42}', 'utf8');
        assert.deepEqual(readJson(file), { k: 42 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('throws with file path on parse error (caller can debug)', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'broken.json');
        fs.writeFileSync(file, '{not: "json"', 'utf8');
        assert.throws(() => readJson(file), err => {
          // Path must appear in the message — it is the *only* signal pointing at the bad file
          // when the call originates deep inside the workflow loop.
          assert.match(err.message, /Failed to parse/);
          assert.ok(err.message.includes(file), `error message should include path "${file}"`);
          return true;
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('rethrows non-ENOENT fs errors (e.g. EISDIR when path is a directory)', () => {
      const dir = tmpDir();
      try {
        // Pass a directory path — fs.readFileSync rejects with EISDIR. Assert
        // the positive code instead of "anything but ENOENT" so a future
        // regression that swallowed EISDIR and threw a code-less Error would
        // fail this test (the old negative check `err.code !== 'ENOENT'`
        // would pass on `err.code === undefined`).
        assert.throws(() => readJson(dir), err => err.code === 'EISDIR');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('appendJsonLine', () => {
    test('appends one JSONL record per call', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'log.jsonl');
        appendJsonLine(file, { i: 1 });
        appendJsonLine(file, { i: 2 });
        appendJsonLine(file, { i: 3 });
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.length > 0);
        assert.deepEqual(lines.map(l => JSON.parse(l)), [{ i: 1 }, { i: 2 }, { i: 3 }]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('creates parent directories when missing', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'a', 'b', 'log.jsonl');
        appendJsonLine(file, { ok: true });
        assert.ok(fs.existsSync(file));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('removePath', () => {
    test('removes a directory recursively', () => {
      const dir = tmpDir();
      try {
        const target = path.join(dir, 'nested', 'tree');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'a.txt'), 'x', 'utf8');
        removePath(path.join(dir, 'nested'));
        assert.ok(!fs.existsSync(path.join(dir, 'nested')));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('removes a single file', () => {
      const dir = tmpDir();
      try {
        const file = path.join(dir, 'data.json');
        fs.writeFileSync(file, '{}', 'utf8');
        removePath(file);
        assert.ok(!fs.existsSync(file));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('does not throw on a missing target (force:true)', () => {
      const dir = tmpDir();
      try {
        assert.doesNotThrow(() => removePath(path.join(dir, 'never-existed')));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
