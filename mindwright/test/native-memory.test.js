// Tests for lib/native-memory.js — the native ~/.claude/projects/<cwd>/memory
// scanner that feeds the unified seed path. Uses a tmp fixture directory so
// the developer's real native-memory tree is never read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNativeMemory } from '../lib/native-memory.js';

function withMemoryDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-nm-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('collectNativeMemory parses frontmatter + body and folds description into content', () => {
  withMemoryDir((dir) => {
    writeFileSync(
      join(dir, 'user_prefers_tabs.md'),
      [
        '---',
        'name: user-prefers-tabs',
        'description: The user prefers tab indentation',
        'metadata:',
        '  type: feedback',
        '---',
        '',
        'The user wants tabs, not spaces, in all source files.',
        '',
        '**Why:** stated explicitly during the editor-config discussion.',
      ].join('\n'),
    );

    const out = collectNativeMemory(dir);
    assert.equal(out.length, 1);
    const row = out[0];
    // description leads, body follows — the consolidator gets both.
    assert.match(row.content, /^The user prefers tab indentation/);
    assert.match(row.content, /tabs, not spaces/);
    assert.match(row.content, /\*\*Why:\*\* stated explicitly/);
    assert.equal(row.sourceRef, 'memory:user_prefers_tabs.md');
    // No frontmatter date → eventTs falls back to the file mtime (an ISO str).
    assert.equal(typeof row.eventTs, 'string', 'eventTs falls back to the file mtime as a string');
    assert.ok(!Number.isNaN(Date.parse(row.eventTs)),
      `eventTs must be ISO-parseable, got ${JSON.stringify(row.eventTs)}`);
  });
});

test('collectNativeMemory skips MEMORY.md (the index, redundant)', () => {
  withMemoryDir((dir) => {
    writeFileSync(join(dir, 'MEMORY.md'), '- [A fact](a.md) — hook\n');
    writeFileSync(
      join(dir, 'a.md'),
      '---\nname: a\ndescription: A real fact\n---\n\nbody of a\n',
    );

    const out = collectNativeMemory(dir);
    assert.equal(out.length, 1, 'MEMORY.md must not produce a row');
    assert.equal(out[0].sourceRef, 'memory:a.md');
  });
});

test('collectNativeMemory prefers a frontmatter date over the file mtime', () => {
  withMemoryDir((dir) => {
    const p = join(dir, 'dated.md');
    writeFileSync(
      p,
      '---\nname: dated\ndescription: has a date\ndate: 2021-03-04T05:06:07.000Z\n---\n\nbody\n',
    );
    // Push the file mtime far away from the frontmatter date so a regression
    // that used mtime instead would be unambiguous.
    const mtime = new Date('2025-12-31T00:00:00.000Z');
    utimesSync(p, mtime, mtime);

    const out = collectNativeMemory(dir);
    assert.equal(out.length, 1);
    assert.equal(
      out[0].eventTs,
      '2021-03-04T05:06:07.000Z',
      'frontmatter date must win over file mtime',
    );
  });
});

test('collectNativeMemory uses file mtime as eventTs when no frontmatter date', () => {
  withMemoryDir((dir) => {
    const p = join(dir, 'plain.md');
    writeFileSync(p, '---\nname: plain\ndescription: no date here\n---\n\nbody\n');
    const mtime = new Date('2024-06-15T12:00:00.000Z');
    utimesSync(p, mtime, mtime);

    const out = collectNativeMemory(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].eventTs, '2024-06-15T12:00:00.000Z');
  });
});

test('collectNativeMemory handles a file with no frontmatter (whole file is body)', () => {
  withMemoryDir((dir) => {
    writeFileSync(join(dir, 'raw.md'), 'just a plain note, no fences\n');
    const out = collectNativeMemory(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'just a plain note, no fences');
    assert.equal(out[0].sourceRef, 'memory:raw.md');
  });
});

test('collectNativeMemory ignores non-.md files and returns sorted order', () => {
  withMemoryDir((dir) => {
    writeFileSync(join(dir, 'zeta.md'), '---\ndescription: z\n---\n\nz body\n');
    writeFileSync(join(dir, 'alpha.md'), '---\ndescription: a\n---\n\na body\n');
    writeFileSync(join(dir, 'notes.txt'), 'not markdown — ignore me\n');
    writeFileSync(join(dir, 'README'), 'no extension — ignore me\n');

    const out = collectNativeMemory(dir);
    assert.deepEqual(
      out.map((r) => r.sourceRef),
      ['memory:alpha.md', 'memory:zeta.md'],
      'only .md files, deterministic sorted order',
    );
  });
});

test('collectNativeMemory skips an empty / whitespace-only file', () => {
  withMemoryDir((dir) => {
    writeFileSync(join(dir, 'empty.md'), '---\nname: empty\n---\n\n   \n');
    writeFileSync(join(dir, 'real.md'), '---\ndescription: real\n---\n\ncontent\n');
    const out = collectNativeMemory(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceRef, 'memory:real.md');
  });
});

test('collectNativeMemory returns [] for an empty directory', () => {
  withMemoryDir((dir) => {
    assert.deepEqual(collectNativeMemory(dir), []);
  });
});

test('collectNativeMemory returns [] when the directory does not exist', () => {
  const missing = join(tmpdir(), `mindwright-nm-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(collectNativeMemory(missing), []);
});
