'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeJson, readJson, appendJsonLine, readJsonLines, removePath } = require('../../coordinator/io');

describe('io', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeJson', () => {
    it('writes valid JSON with pretty printing', () => {
      const filePath = path.join(tmpDir, 'test.json');
      writeJson(filePath, { a: 1, b: 'hello' });
      const raw = fs.readFileSync(filePath, 'utf8');
      assert.deepEqual(JSON.parse(raw), { a: 1, b: 'hello' });
      assert.ok(raw.includes('\n'), 'Should be pretty-printed');
    });

    it('creates parent directories if missing', () => {
      const filePath = path.join(tmpDir, 'nested', 'deep', 'test.json');
      writeJson(filePath, { ok: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ok: true });
    });

    it('overwrites existing file atomically', () => {
      const filePath = path.join(tmpDir, 'overwrite.json');
      writeJson(filePath, { version: 1 });
      writeJson(filePath, { version: 2 });
      assert.deepEqual(readJson(filePath), { version: 2 });
    });

    it('cleans up temp file on non-retryable failure', () => {
      // Point at a path where the directory itself is a file (not a dir)
      const blocker = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blocker, 'not a dir', 'utf8');
      const filePath = path.join(blocker, 'sub', 'test.json');
      assert.throws(() => writeJson(filePath, { bad: true }));
      // No orphan .tmp files should remain in tmpDir
      const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
      assert.equal(tmpFiles.length, 0, 'Should not leave orphan .tmp files');
    });
  });

  describe('readJson', () => {
    it('reads valid JSON file', () => {
      const filePath = path.join(tmpDir, 'read.json');
      fs.writeFileSync(filePath, '{"x":42}', 'utf8');
      assert.deepEqual(readJson(filePath), { x: 42 });
    });

    it('returns fallback for missing file', () => {
      assert.equal(readJson(path.join(tmpDir, 'missing.json')), null);
      assert.deepEqual(readJson(path.join(tmpDir, 'missing.json'), { default: true }), { default: true });
    });

    it('returns fallback for invalid JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json {{{', 'utf8');
      assert.equal(readJson(filePath, 'fallback'), 'fallback');
    });

    it('throws for non-ENOENT / non-SyntaxError', () => {
      // Reading a directory should throw EISDIR, not return fallback
      assert.throws(() => readJson(tmpDir), { code: 'EISDIR' });
    });
  });

  describe('appendJsonLine', () => {
    it('appends newline-delimited JSON', () => {
      const filePath = path.join(tmpDir, 'lines.jsonl');
      appendJsonLine(filePath, { id: 1 });
      appendJsonLine(filePath, { id: 2 });
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n');
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { id: 1 });
      assert.deepEqual(JSON.parse(lines[1]), { id: 2 });
    });

    it('creates parent directories if missing', () => {
      const filePath = path.join(tmpDir, 'deep', 'nested', 'lines.jsonl');
      appendJsonLine(filePath, { ok: true });
      assert.ok(fs.existsSync(filePath));
    });
  });

  describe('readJsonLines', () => {
    it('reads valid JSONL file', () => {
      const filePath = path.join(tmpDir, 'valid.jsonl');
      fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n', 'utf8');
      const result = readJsonLines(filePath);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { a: 1 });
      assert.deepEqual(result[1], { b: 2 });
    });

    it('returns fallback for missing file', () => {
      const result = readJsonLines(path.join(tmpDir, 'missing.jsonl'));
      assert.deepEqual(result, []);
    });

    it('returns custom fallback for missing file', () => {
      const result = readJsonLines(path.join(tmpDir, 'missing.jsonl'), [{ default: true }]);
      assert.deepEqual(result, [{ default: true }]);
    });

    it('skips blank lines', () => {
      const filePath = path.join(tmpDir, 'blanks.jsonl');
      fs.writeFileSync(filePath, '{"a":1}\n\n\n{"b":2}\n\n', 'utf8');
      const result = readJsonLines(filePath);
      assert.equal(result.length, 2);
    });

    it('skips corrupt lines and reports skipped count', () => {
      const filePath = path.join(tmpDir, 'mixed.jsonl');
      fs.writeFileSync(filePath, '{"ok":true}\nnot json\n{"also":"ok"}\nbroken{{\n', 'utf8');
      const result = readJsonLines(filePath);
      assert.equal(result.length, 2);
      assert.equal(result.skipped, 2);
    });

    it('handles Windows-style line endings', () => {
      const filePath = path.join(tmpDir, 'crlf.jsonl');
      fs.writeFileSync(filePath, '{"a":1}\r\n{"b":2}\r\n', 'utf8');
      const result = readJsonLines(filePath);
      assert.equal(result.length, 2);
    });
  });

  describe('removePath', () => {
    it('removes a file', () => {
      const filePath = path.join(tmpDir, 'remove-me.txt');
      fs.writeFileSync(filePath, 'bye', 'utf8');
      removePath(filePath);
      assert.ok(!fs.existsSync(filePath));
    });

    it('removes a directory recursively', () => {
      const dirPath = path.join(tmpDir, 'remove-dir', 'nested');
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, 'file.txt'), 'data', 'utf8');
      removePath(path.join(tmpDir, 'remove-dir'));
      assert.ok(!fs.existsSync(path.join(tmpDir, 'remove-dir')));
    });

    it('does not throw for nonexistent path', () => {
      assert.doesNotThrow(() => removePath(path.join(tmpDir, 'ghost')));
    });
  });
});
