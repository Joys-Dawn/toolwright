// Tests for lib/role-sidecar.js — the per-session JSON file the PostToolUse-
// on-wrightward_list_inbox hook uses to detect role-set changes between
// firings. Sidecar shape: a JSON array of role strings under
// .claude/mindwright/sessions/<session_id>/role.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  sidecarPath,
  readSidecar,
  writeSidecar,
  removeSidecar,
  diffRoles,
} from '../lib/role-sidecar.js';

const SAFE_SID = 'sess-roles-A';
const PATH_UNSAFE_SID = '../etc/passwd';

function withProjectRoot(fn) {
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-rs-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

// ----- sidecarPath -------------------------------------------------------

test('sidecarPath places role.json under .claude/mindwright/sessions/<sid>/', () => {
  withProjectRoot((root) => {
    const p = sidecarPath(SAFE_SID);
    assert.equal(p, join(root, '.claude', 'mindwright', 'sessions', SAFE_SID, 'role.json'));
  });
});

test('sidecarPath rejects a path-traversal session id', () => {
  withProjectRoot(() => {
    assert.throws(() => sidecarPath(PATH_UNSAFE_SID), /session_id is not path-safe/);
  });
});

// ----- readSidecar -------------------------------------------------------

test('readSidecar returns [] when the file is missing', () => {
  withProjectRoot(() => {
    assert.deepEqual(readSidecar(SAFE_SID), []);
  });
});

test('readSidecar returns the persisted role list for a valid file', () => {
  withProjectRoot(() => {
    const p = sidecarPath(SAFE_SID);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(['planner', 'tester']), 'utf8');
    assert.deepEqual(readSidecar(SAFE_SID), ['planner', 'tester']);
  });
});

test('readSidecar returns [] when JSON is malformed (corrupted file recovery)', () => {
  // Recovery contract: every current role is treated as "newly added" and
  // re-injected — better to over-inject than to miss a role the agent
  // legitimately holds.
  withProjectRoot(() => {
    const p = sidecarPath(SAFE_SID);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{not json', 'utf8');
    assert.deepEqual(readSidecar(SAFE_SID), []);
  });
});

test('readSidecar returns [] when JSON is an object (not an array)', () => {
  withProjectRoot(() => {
    const p = sidecarPath(SAFE_SID);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ roles: ['planner'] }), 'utf8');
    assert.deepEqual(readSidecar(SAFE_SID), []);
  });
});

test('readSidecar filters out non-string and empty-string entries', () => {
  withProjectRoot(() => {
    const p = sidecarPath(SAFE_SID);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(['planner', '', null, 42, 'tester']), 'utf8');
    assert.deepEqual(readSidecar(SAFE_SID), ['planner', 'tester']);
  });
});

// ----- writeSidecar ------------------------------------------------------

test('writeSidecar creates the parent directory and persists pretty JSON', () => {
  withProjectRoot(() => {
    writeSidecar(SAFE_SID, ['planner']);
    const p = sidecarPath(SAFE_SID);
    assert.ok(existsSync(p), 'sidecar file should exist after write');
    const raw = readFileSync(p, 'utf8');
    assert.deepEqual(JSON.parse(raw), ['planner']);
    // Pretty-printed with 2-space indent so the user can read it directly.
    assert.match(raw, /\n {2}"planner"/);
  });
});

test('writeSidecar followed by readSidecar round-trips the role list', () => {
  withProjectRoot(() => {
    writeSidecar(SAFE_SID, ['planner', 'tester']);
    assert.deepEqual(readSidecar(SAFE_SID), ['planner', 'tester']);
  });
});

test('writeSidecar overwrites prior contents', () => {
  withProjectRoot(() => {
    writeSidecar(SAFE_SID, ['planner']);
    writeSidecar(SAFE_SID, ['implementer', 'reviewer']);
    assert.deepEqual(readSidecar(SAFE_SID), ['implementer', 'reviewer']);
  });
});

// ----- removeSidecar -----------------------------------------------------

test('removeSidecar deletes an existing sidecar', () => {
  withProjectRoot(() => {
    writeSidecar(SAFE_SID, ['planner']);
    removeSidecar(SAFE_SID);
    assert.ok(!existsSync(sidecarPath(SAFE_SID)));
  });
});

test('removeSidecar is a no-op when the file does not exist', () => {
  withProjectRoot(() => {
    // Must not throw — SessionEnd calls this unconditionally.
    removeSidecar(SAFE_SID);
    assert.ok(!existsSync(sidecarPath(SAFE_SID)));
  });
});

// ----- diffRoles ---------------------------------------------------------

test('diffRoles reports added and removed by set semantics', () => {
  const { added, removed } = diffRoles(['planner', 'tester'], ['planner', 'reviewer']);
  assert.deepEqual(added, ['reviewer']);
  assert.deepEqual(removed, ['tester']);
});

test('diffRoles returns empty arrays when prev and curr are identical', () => {
  const out = diffRoles(['planner', 'tester'], ['tester', 'planner']);
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.removed, []);
});

test('diffRoles handles both arrays empty', () => {
  const out = diffRoles([], []);
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.removed, []);
});

test('diffRoles handles prev empty (everything is added)', () => {
  const out = diffRoles([], ['planner', 'tester']);
  assert.deepEqual(out.added.sort(), ['planner', 'tester']);
  assert.deepEqual(out.removed, []);
});

test('diffRoles handles curr empty (everything is removed)', () => {
  const out = diffRoles(['planner', 'tester'], []);
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.removed.sort(), ['planner', 'tester']);
});

test('diffRoles dedupes within each input before computing the diff', () => {
  const out = diffRoles(['planner', 'planner'], ['planner', 'planner', 'tester']);
  assert.deepEqual(out.added, ['tester']);
  assert.deepEqual(out.removed, []);
});

test('diffRoles tolerates non-array inputs (treated as empty)', () => {
  const out = diffRoles(null, ['planner']);
  assert.deepEqual(out.added, ['planner']);
  assert.deepEqual(out.removed, []);
  const out2 = diffRoles(['planner'], undefined);
  assert.deepEqual(out2.added, []);
  assert.deepEqual(out2.removed, ['planner']);
});
