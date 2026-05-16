import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRoster, resolveTargetToSessionId } from '../lib/agents-roster.js';
import { deriveHandle } from '../lib/handles.js';

// Helper — install a temp projectRoot, run fn, restore env. The
// agents-roster.js reader calls collabDir() which resolves to
// <projectRoot>/.claude/collab. We plant agents.json there (or skip it to
// test the missing-file path).
function withRoster(rosterContentOrNull, fn) {
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-roster-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  try {
    if (rosterContentOrNull !== null) {
      const collabPath = join(dir, '.claude', 'collab');
      mkdirSync(collabPath, { recursive: true });
      writeFileSync(join(collabPath, 'agents.json'), rosterContentOrNull, 'utf8');
    }
    return fn(dir);
  } finally {
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

// ---------- readRoster ----------

test('readRoster returns {} when agents.json is missing entirely', () => {
  withRoster(null, () => {
    assert.deepEqual(readRoster(), {});
  });
});

test('readRoster returns {} when agents.json is unparseable (truncated/invalid JSON)', () => {
  withRoster('{"sid-1": {"handle": "ada-1"', () => {
    assert.deepEqual(readRoster(), {});
  });
});

test('readRoster returns {} when agents.json parses to a non-object root', () => {
  withRoster('null', () => assert.deepEqual(readRoster(), {}));
  withRoster('"a string"', () => assert.deepEqual(readRoster(), {}));
  withRoster('42', () => assert.deepEqual(readRoster(), {}));
});

test('readRoster returns {} when agents.json parses to an array (not an object map)', () => {
  withRoster('[{"handle": "ada-1"}]', () => {
    assert.deepEqual(readRoster(), {});
  });
});

test('readRoster synthesizes handle via deriveHandle when row lacks handle field', () => {
  const sid = 'sid-missing-handle';
  const expected = deriveHandle(sid);
  withRoster(JSON.stringify({ [sid]: { registered_at: 'x', last_active: 'y' } }), () => {
    const roster = readRoster();
    assert.equal(roster[sid].handle, expected,
      'missing handle must fall back to deriveHandle(sid) so stale rows still resolve');
  });
});

test('readRoster re-derives handle when row carries a malformed handle (fails HANDLE_PATTERN)', () => {
  const sid = 'sid-bad-handle';
  const expected = deriveHandle(sid);
  withRoster(JSON.stringify({ [sid]: { handle: 'NotAHandle!', registered_at: 'x' } }), () => {
    const roster = readRoster();
    assert.equal(roster[sid].handle, expected,
      'malformed handles must be replaced via deriveHandle, not propagated downstream');
  });
});

test('readRoster drops rows where the sessionId key is empty', () => {
  withRoster(JSON.stringify({ '': { handle: 'ada-1' }, 'valid-sid': { handle: 'bob-2' } }), () => {
    const roster = readRoster();
    assert.equal(Object.keys(roster).length, 1);
    assert.equal(roster['valid-sid'].handle, 'bob-2');
  });
});

test('readRoster drops rows where the value is not an object', () => {
  withRoster(JSON.stringify({
    'sid-1': 'oops-a-string',
    'sid-2': null,
    'sid-3': { handle: 'ada-1' },
  }), () => {
    const roster = readRoster();
    assert.equal(Object.keys(roster).length, 1);
    assert.equal(roster['sid-3'].handle, 'ada-1');
  });
});

test('readRoster preserves registered_at and last_active fields, defaulting absent ones to null', () => {
  withRoster(JSON.stringify({
    'sid-1': { handle: 'ada-1', registered_at: '2026-05-13T00:00:00Z', last_active: '2026-05-13T01:00:00Z' },
    'sid-2': { handle: 'bob-2' },
  }), () => {
    const roster = readRoster();
    assert.equal(roster['sid-1'].registered_at, '2026-05-13T00:00:00Z');
    assert.equal(roster['sid-1'].last_active, '2026-05-13T01:00:00Z');
    assert.equal(roster['sid-2'].registered_at, null);
    assert.equal(roster['sid-2'].last_active, null);
  });
});

// ---------- resolveTargetToSessionId ----------

test('resolveTargetToSessionId returns error for empty string with liveHandles=[]', () => {
  withRoster(null, () => {
    const res = resolveTargetToSessionId('');
    assert.equal(res.ok, false);
    assert.match(res.error, /non-empty string/);
    assert.deepEqual(res.liveHandles, []);
  });
});

test('resolveTargetToSessionId returns error for non-string input', () => {
  withRoster(null, () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const res = resolveTargetToSessionId(bad);
      assert.equal(res.ok, false, `expected ok=false for ${JSON.stringify(bad)}`);
      assert.match(res.error, /non-empty string/);
    }
  });
});

test('resolveTargetToSessionId passes through a UUID-shaped sessionId without touching the roster', () => {
  // No agents.json on disk — pure passthrough.
  withRoster(null, () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const res = resolveTargetToSessionId(uuid);
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, uuid);
  });
});

test('resolveTargetToSessionId resolves a known handle to its sessionId via the roster', () => {
  const sid = 'sid-known-bob';
  const handle = deriveHandle(sid);
  withRoster(JSON.stringify({ [sid]: { handle } }), () => {
    const res = resolveTargetToSessionId(handle);
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, sid);
  });
});

test('resolveTargetToSessionId returns ok:false + sorted liveHandles when handle not in roster', () => {
  withRoster(JSON.stringify({
    'sid-1': { handle: 'zoe-1' },
    'sid-2': { handle: 'ada-1' },
    'sid-3': { handle: 'mara-9' },
  }), () => {
    const res = resolveTargetToSessionId('ghost-42');
    assert.equal(res.ok, false);
    assert.match(res.error, /not a live wrightward handle/);
    assert.deepEqual(res.liveHandles, ['ada-1', 'mara-9', 'zoe-1'],
      'liveHandles must be sorted alphabetically so the LLM can scan them deterministically');
  });
});

test('resolveTargetToSessionId returns ok:false with liveHandles when input is neither UUID nor handle', () => {
  withRoster(JSON.stringify({ 'sid-1': { handle: 'ada-1' } }), () => {
    const res = resolveTargetToSessionId('not!a!handle');
    assert.equal(res.ok, false);
    assert.match(res.error, /neither a UUID session_id nor a wrightward handle/);
    assert.deepEqual(res.liveHandles, ['ada-1']);
  });
});

test('resolveTargetToSessionId rejects UUID-shaped input that also matches HANDLE_PATTERN ambiguity boundary', () => {
  // The implementation accepts SESSION_ID_PATTERN-matching strings that do
  // NOT also match HANDLE_PATTERN. A string like "ada-1" matches both
  // patterns but the handle-resolution branch wins because of the explicit
  // `!HANDLE_PATTERN.test(input)` guard. Verify that's preserved.
  withRoster(JSON.stringify({ 'sid-1': { handle: 'ada-1' } }), () => {
    const res = resolveTargetToSessionId('ada-1');
    assert.equal(res.ok, true,
      'handle-shaped input must route through handle resolution, not UUID passthrough');
    assert.equal(res.sessionId, 'sid-1');
  });
});
