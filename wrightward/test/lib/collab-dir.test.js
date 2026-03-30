'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureCollabDir } = require('../../lib/collab-dir');

describe('ensureCollabDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .collab/ and subdirectories', () => {
    const collabDir = ensureCollabDir(tmpDir);
    assert.equal(collabDir, path.join(tmpDir, '.collab'));
    assert.ok(fs.existsSync(path.join(tmpDir, '.collab')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.collab', 'context')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.collab', 'last-seen')));
  });

  it('creates .gitignore with .collab/ entry', () => {
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.collab/'));
  });

  it('does not duplicate .gitignore entry', () => {
    ensureCollabDir(tmpDir);
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.collab\//g);
    assert.equal(matches.length, 1);
  });

  it('appends to existing .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf8');
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.collab/'));
  });

  it('handles .gitignore without trailing newline', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/', 'utf8');
    ensureCollabDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.collab/'));
    // Should have a newline between entries
    assert.ok(content.includes('node_modules/\n'));
  });

  it('is idempotent', () => {
    ensureCollabDir(tmpDir);
    ensureCollabDir(tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, '.collab')));
  });
});
