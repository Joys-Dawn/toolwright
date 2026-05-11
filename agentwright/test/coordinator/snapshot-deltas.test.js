'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDeltas,
  loadSnapshotMeta,
  parseDirectoryNumstatZ,
  classifyDiffPath,
  getGitVisibleFiles,
} = require('../../coordinator/snapshot-deltas');
const { shouldExclude } = require('../../coordinator/exclude-rules');

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function gitInit(cwd) {
  const opts = { cwd, encoding: 'utf8' };
  spawnSync('git', ['init', '-q'], opts);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], opts);
  spawnSync('git', ['config', 'user.name', 'Test'], opts);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], opts);
}

function gitCommitAll(cwd, msg) {
  const opts = { cwd, encoding: 'utf8' };
  spawnSync('git', ['add', '-A'], opts);
  spawnSync('git', ['commit', '-q', '-m', msg], opts);
}

describe('snapshot-deltas', () => {
  describe('shouldExclude (re-checked here so the delta side stays aligned)', () => {
    test('drops EXCLUDED_ROOTS at any path depth', () => {
      assert.equal(shouldExclude('node_modules/foo/index.js'), true);
      assert.equal(shouldExclude('packages/a/node_modules/foo.js'), true);
      assert.equal(shouldExclude('.claude/forgewright/workflows/x.json'), true);
      assert.equal(shouldExclude('dist/bundle.js'), true);
      assert.equal(shouldExclude('.next/static/chunks/main.js'), true);
    });

    test('drops secret env files but NOT .env.example or templates', () => {
      assert.equal(shouldExclude('.env'), true);
      assert.equal(shouldExclude('.env.local'), true);
      assert.equal(shouldExclude('.env.production.local'), true);
      assert.equal(shouldExclude('.env.example'), false);
      assert.equal(shouldExclude('.env.template'), false);
      assert.equal(shouldExclude('.env.sample'), false);
    });

    test('keeps normal source paths', () => {
      assert.equal(shouldExclude('src/index.js'), false);
      assert.equal(shouldExclude('coordinator/snapshot-deltas.js'), false);
      assert.equal(shouldExclude(''), false);
    });
  });

  describe('computeDeltas', () => {
    let cwd;
    let snapshotDir;

    before(() => {
      cwd = mktmp('aw-deltas-cwd-');
      gitInit(cwd);

      writeFile(path.join(cwd, 'src', 'a.js'), 'line1\nline2\nline3\n');
      writeFile(path.join(cwd, 'src', 'b.js'), 'b1\nb2\n');
      writeFile(path.join(cwd, 'node_modules', 'pkg', 'index.js'), 'x\n'.repeat(100));
      writeFile(path.join(cwd, '.claude', 'audit-runs', 'run-1', 'group-0-snapshot.json'), '{}');
      writeFile(path.join(cwd, 'dist', 'bundle.js'), 'compiled\n'.repeat(200));
      writeFile(path.join(cwd, '.env'), 'SECRET=hunter2\n');
      writeFile(path.join(cwd, '.gitignore'), 'extras/\n');
      writeFile(path.join(cwd, 'extras', 'scratch.js'), 'scratch\n'.repeat(50));
      gitCommitAll(cwd, 'initial');

      snapshotDir = mktmp('aw-deltas-snap-');
      writeFile(path.join(snapshotDir, 'src', 'a.js'), 'line1\nline2\nline3\n');
      writeFile(path.join(snapshotDir, 'src', 'b.js'), 'b1\nb2\n');
      writeFile(path.join(snapshotDir, '.gitignore'), 'extras/\n');

      // Mutate cwd: edit a.js, add c.js, churn .claude/, churn extras/
      writeFile(path.join(cwd, 'src', 'a.js'), 'line1\nNEW\nline3\n');
      writeFile(path.join(cwd, 'src', 'c.js'), 'c1\nc2\nc3\n');
      writeFile(path.join(cwd, '.claude', 'audit-runs', 'run-1', 'group-0-snapshot.json'), '{"churn":true}');
      writeFile(path.join(cwd, 'extras', 'scratch.js'), 'scratch-modified\n'.repeat(80));
      writeFile(path.join(cwd, 'node_modules', 'pkg', 'index.js'), 'x\n'.repeat(150));
    });

    after(() => {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    });

    test('counts only visible source changes; ignores excluded + gitignored noise', () => {
      const d = computeDeltas(cwd, snapshotDir);
      const changedNorm = d.changedFiles.map(f => f.split(path.sep).join('/')).sort();
      assert.deepEqual(changedNorm, ['src/a.js', 'src/c.js']);
      assert.equal(d.totalAdded, 4);
      assert.equal(d.totalDeleted, 1);
      assert.equal(d.totalDiffLines, 5);
      assert.ok(!changedNorm.some(f => f.startsWith('node_modules/')));
      assert.ok(!changedNorm.some(f => f.startsWith('.claude/')));
      assert.ok(!changedNorm.some(f => f.startsWith('dist/')));
      assert.ok(!changedNorm.includes('.env'));
      assert.ok(!changedNorm.some(f => f.startsWith('extras/')));
    });

    test('throws when snapshot path is missing', () => {
      assert.throws(
        () => computeDeltas(cwd, path.join(snapshotDir, '..', 'no-such-dir-xyz')),
        /Snapshot path missing/
      );
    });
  });

  describe('loadSnapshotMeta', () => {
    test('returns null when the snapshot file does not exist', () => {
      const dir = mktmp('aw-meta-missing-');
      try {
        assert.equal(loadSnapshotMeta(dir, '2026-01-01-runid-aaaaaaaa', 0), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('parses the JSON payload when the file exists', () => {
      const dir = mktmp('aw-meta-present-');
      try {
        const runId = '2026-01-01-runid-aaaaaaaa';
        const file = path.join(dir, '.claude', 'audit-runs', runId, 'group-0-snapshot.json');
        const payload = { type: 'git-worktree', path: '/tmp/snap' };
        writeFile(file, JSON.stringify(payload));
        assert.deepEqual(loadSnapshotMeta(dir, runId, 0), payload);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('getGitVisibleFiles', () => {
    test('returns null when cwd is not a git repository', () => {
      const dir = mktmp('aw-non-git-');
      try {
        assert.equal(getGitVisibleFiles(dir), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('returns a Set of normalized paths in a git repo (gitignored excluded)', () => {
      const dir = mktmp('aw-git-visible-');
      try {
        gitInit(dir);
        writeFile(path.join(dir, 'src', 'a.js'), 'a\n');
        writeFile(path.join(dir, 'src', 'b.js'), 'b\n');
        writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
        writeFile(path.join(dir, 'ignored.txt'), 'should not appear\n');
        gitCommitAll(dir, 'init');
        const set = getGitVisibleFiles(dir);
        assert.ok(set instanceof Set);
        const norm = [...set].map(f => f.split(path.sep).join('/'));
        assert.ok(norm.includes('src/a.js'));
        assert.ok(norm.includes('src/b.js'));
        assert.ok(norm.includes('.gitignore'));
        assert.ok(!norm.includes('ignored.txt'), 'gitignored files must not appear');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('parseDirectoryNumstatZ', () => {
    test('returns valid records and skips malformed ones', () => {
      const stdout = [
        '5\t2\t', 'a/old.js', 'b/old.js',
        'BROKEN_HEADER',  'orphan',  'orphan2',
        '0\t10\t', 'a/del.js', '/dev/null',
      ].join('\0');
      const records = parseDirectoryNumstatZ(stdout);
      assert.equal(records.length, 2);
      assert.deepEqual(records[0], {
        added: 5, deleted: 2, binary: false, oldRaw: 'a/old.js', newRaw: 'b/old.js',
      });
      assert.deepEqual(records[1], {
        added: 0, deleted: 10, binary: false, oldRaw: 'a/del.js', newRaw: '/dev/null',
      });
    });

    test('treats binary marker "-\\t-" as binary with zero counts', () => {
      const stdout = ['-\t-\t', 'a/img.png', 'b/img.png'].join('\0');
      const records = parseDirectoryNumstatZ(stdout);
      assert.equal(records.length, 1);
      assert.equal(records[0].binary, true);
      assert.equal(records[0].added, 0);
      assert.equal(records[0].deleted, 0);
    });

    test('returns [] on empty input', () => {
      assert.deepEqual(parseDirectoryNumstatZ(''), []);
    });

    test('skips trailing partial record with too few tokens', () => {
      const stdout = ['1\t1\t', 'old', 'new', 'lonely-header'].join('\0');
      const records = parseDirectoryNumstatZ(stdout);
      assert.equal(records.length, 1);
      assert.equal(records[0].oldRaw, 'old');
    });
  });

  describe('classifyDiffPath', () => {
    test('returns null for /dev/null and "nul" sentinels', () => {
      const snap = path.resolve('/tmp/snap');
      const cwd = path.resolve('/tmp/cwd');
      assert.equal(classifyDiffPath('/dev/null', snap, cwd), null);
      assert.equal(classifyDiffPath('nul', snap, cwd), null);
      assert.equal(classifyDiffPath('', snap, cwd), null);
      assert.equal(classifyDiffPath(null, snap, cwd), null);
    });

    test('classifies a cwd-side path with normalized separators', () => {
      const snapRoot = mktmp('aw-snap-root-');
      const cwdRoot = mktmp('aw-cwd-root-');
      try {
        const snap = path.resolve(snapRoot);
        const cwd = path.resolve(cwdRoot);
        const cwdFile = path.join(cwd, 'src', 'a.js');
        const result = classifyDiffPath(cwdFile.split(path.sep).join('/'), snap, cwd);
        assert.ok(result, 'expected classification, got null');
        assert.equal(result.side, 'cwd');
        assert.equal(result.rel.split(path.sep).join('/'), 'src/a.js');
      } finally {
        fs.rmSync(snapRoot, { recursive: true, force: true });
        fs.rmSync(cwdRoot, { recursive: true, force: true });
      }
    });

    test('classifies a snapshot-side path', () => {
      const snapRoot = mktmp('aw-snap-root-');
      const cwdRoot = mktmp('aw-cwd-root-');
      try {
        const snap = path.resolve(snapRoot);
        const cwd = path.resolve(cwdRoot);
        const snapFile = path.join(snap, 'src', 'b.js');
        const result = classifyDiffPath(snapFile.split(path.sep).join('/'), snap, cwd);
        assert.ok(result);
        assert.equal(result.side, 'snap');
        assert.equal(result.rel.split(path.sep).join('/'), 'src/b.js');
      } finally {
        fs.rmSync(snapRoot, { recursive: true, force: true });
        fs.rmSync(cwdRoot, { recursive: true, force: true });
      }
    });

    test('returns null for a path that falls outside both roots', () => {
      const snapRoot = mktmp('aw-snap-root-');
      const cwdRoot = mktmp('aw-cwd-root-');
      try {
        const snap = path.resolve(snapRoot);
        const cwd = path.resolve(cwdRoot);
        const orphan = path.resolve(os.tmpdir(), 'definitely-not-under-snap-or-cwd-zzz', 'x.js');
        assert.equal(classifyDiffPath(orphan.split(path.sep).join('/'), snap, cwd), null);
      } finally {
        fs.rmSync(snapRoot, { recursive: true, force: true });
        fs.rmSync(cwdRoot, { recursive: true, force: true });
      }
    });
  });
});
