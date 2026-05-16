// Tests for hooks/post-tool-use-inbox.js — the PostToolUse hook narrow-
// matched to wrightward_list_inbox. Two jobs:
//   1) Diff the active role-set against the sidecar; on add/remove, inject
//      role-prompt fragments or unassign notices via hookSpecificOutput.
//   2) Re-ground the SELF_RECALL_RULE on every firing so it stays sticky
//      in the agent's recent context window.
//
// We spawn the hook as a subprocess (matches how Claude Code launches it
// in production) and inspect the JSON envelope on stdout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../lib/store.js';
import { sidecarPath } from '../../lib/role-sidecar.js';
import { ROLE_PROMPTS } from '../../lib/role-prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const HOOK_SCRIPT = join(PLUGIN_ROOT, 'hooks', 'post-tool-use-inbox.js');

function setupIsolatedRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'mindwright-pti-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'mindwright-pti-home-'));
  const prev = process.env.MINDWRIGHT_PROJECT_ROOT;
  process.env.MINDWRIGHT_PROJECT_ROOT = dir;
  // The hook's SELF_RECALL_RULE emission is gated on
  // (embedderCached() && long_count > 0). Plant a fake model cache here so
  // the embedder gate is satisfied; tests that exercise the re-injection
  // path additionally plant a long-tier fact via plantLongFact() below.
  mkdirSync(join(homeDir, '.cache', 'huggingface', 'hub', 'models--Xenova--bge-m3'), { recursive: true });
  return {
    dir,
    homeDir,
    cleanup() {
      if (prev === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
      else process.env.MINDWRIGHT_PROJECT_ROOT = prev;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
      try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
}

// Insert a single long-tier fact so longCount > 0 and the SELF_RECALL_RULE
// gate fires. Returns nothing — the row id is irrelevant to the caller.
function plantLongFact(dir) {
  const store = openStore();
  try {
    store.insertEntry({
      tier: 'long',
      category: 'fact',
      scope: 'project',
      kind: 'fact',
      content: 'recall-gate sentinel fact',
      sessionId: 'sentinel-sess',
      confidence: 1.0,
      embedding: null,
    });
  } finally {
    store.close();
  }
}

function runHook(input, projectRoot, homeDir = null) {
  const env = { ...process.env, MINDWRIGHT_PROJECT_ROOT: projectRoot };
  if (homeDir) {
    // Mirror hooks.test.js's runHook: redirect Node's homedir() so the hook
    // subprocess's hfCacheDir() lands under the tmp HOME we control. Both
    // HOME (POSIX) and USERPROFILE (Windows) must be set.
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
  }
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
  const stdout = res.stdout.trim();
  let parsed = {};
  try { parsed = JSON.parse(stdout); } catch { /* hook crashed before emitting JSON */ }
  return { status: res.status, stdout: parsed, stderr: res.stderr };
}

function writeSidecarRaw(sessionId, content) {
  const p = sidecarPath(sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

// ----- guards ------------------------------------------------------------

test('post-tool-use-inbox emits {} when stdin is not JSON', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: 'not json {{',
      encoding: 'utf8',
      env: { ...process.env, MINDWRIGHT_PROJECT_ROOT: dir },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '{}');
  } finally {
    cleanup();
  }
});

test('post-tool-use-inbox emits {} when session_id is missing', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const { status, stdout } = runHook({ /* no session_id */ }, dir);
    assert.equal(status, 0);
    assert.deepEqual(stdout, {});
  } finally {
    cleanup();
  }
});

test('post-tool-use-inbox emits {} when openStore throws (DB path is a directory)', () => {
  // Defensive boundary: a DB-locked or migration-corrupted state must not
  // crash the subprocess and block the user's next turn. The hook's first
  // try/catch around openStore() (lines 42-49) is the safety net — verify
  // it engages by forcing a guaranteed-throw setup: plant a directory at
  // the DB file path. better-sqlite3's `new Database(<dir>)` fails on
  // every platform with EISDIR/equivalent so the hook's catch is the only
  // way the subprocess returns clean stdout.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    // Pre-create the dbPath as a DIRECTORY so better-sqlite3 can't open it.
    const dbFilePath = join(dir, '.claude', 'mindwright', 'mindwright.db');
    mkdirSync(dbFilePath, { recursive: true });

    const { status, stdout, stderr } = runHook({ session_id: 'sess-broken-store' }, dir);
    assert.equal(status, 0, `hook must exit 0 even when openStore throws. stderr:\n${stderr}`);
    assert.deepEqual(stdout, {},
      'hook must emit clean {} envelope when openStore fails — degrades silently');
    assert.match(stderr, /\[mindwright\/post-tool-use-inbox\] store open failed:/,
      'failure must be logged to stderr via logHookError');
  } finally {
    cleanup();
  }
});

// ----- self-recall re-injection (always-on) ------------------------------

test('post-tool-use-inbox always re-injects SELF_RECALL_RULE when session_id is present', () => {
  // The hook is the only between-turn surface for re-grounding voluntary-
  // compliance instructions. Even when the role set is unchanged, the
  // self-recall reminder must come back so it stays in the agent's recent
  // context window. As of behavior-1 the rule is gated on (embedderCached
  // && long_count > 0), so the setup plants a fake model cache + a long-
  // tier fact to satisfy the gate; the property under test (sticky re-
  // emission while recall is live) is unchanged.
  const { dir, homeDir, cleanup } = setupIsolatedRoot();
  try {
    plantLongFact(dir);
    const sid = 'sess-recall-A';
    const { status, stdout } = runHook({ session_id: sid }, dir, homeDir);
    assert.equal(status, 0);
    const ctx = stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /mindwright_recall/,
      'self-recall rule must reference the MCP tool name');
    assert.equal(stdout.hookSpecificOutput.hookEventName, 'PostToolUse');
  } finally {
    cleanup();
  }
});

// ----- role-added path ---------------------------------------------------

test('post-tool-use-inbox injects the added-role prompt fragment when a role is newly assigned', () => {
  const { dir, homeDir, cleanup } = setupIsolatedRoot();
  try {
    plantLongFact(dir);
    const sid = 'sess-add-A';
    // Plant `planner` directly in the DB; leave the sidecar absent so the
    // diff treats `planner` as "newly added" on first fire.
    const store = openStore();
    try { store.setRoles(sid, ['planner']); } finally { store.close(); }

    const { status, stdout } = runHook({ session_id: sid }, dir, homeDir);
    assert.equal(status, 0);
    const ctx = stdout?.hookSpecificOutput?.additionalContext || '';
    // Prompt fragment for `planner` (substring match; full fragment lives in
    // ROLE_PROMPTS.planner) must appear.
    assert.match(ctx, /\[role:planner\]/);
    // Take a stable substring from the planner fragment to verify content.
    assert.ok(
      ctx.includes(ROLE_PROMPTS.planner.slice(0, 40)),
      'added-role injection must contain the planner prompt body',
    );
    // Self-recall rule must still ride along on the same firing.
    assert.match(ctx, /mindwright_recall/);
  } finally {
    cleanup();
  }
});

// ----- role-removed path -------------------------------------------------

test('post-tool-use-inbox surfaces an unassign notice when a role was removed since the last fire', () => {
  const { dir, homeDir, cleanup } = setupIsolatedRoot();
  try {
    plantLongFact(dir);
    const sid = 'sess-rm-A';
    // Sidecar says [planner]; DB now empty → diff yields removed=[planner].
    writeSidecarRaw(sid, JSON.stringify(['planner']));
    const store = openStore();
    try { store.setRoles(sid, []); } finally { store.close(); }

    const { status, stdout } = runHook({ session_id: sid }, dir, homeDir);
    assert.equal(status, 0);
    const ctx = stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /\[role:planner\] role unassigned/);
    assert.match(ctx, /mindwright_recall/, 'self-recall rule still re-injected');
  } finally {
    cleanup();
  }
});

// ----- no-change path ----------------------------------------------------

test('post-tool-use-inbox skips role messaging when the role-set is unchanged', () => {
  const { dir, homeDir, cleanup } = setupIsolatedRoot();
  try {
    plantLongFact(dir);
    const sid = 'sess-noop-A';
    // Both sidecar and DB say [planner] → diff is empty → no role lines.
    writeSidecarRaw(sid, JSON.stringify(['planner']));
    const store = openStore();
    try { store.setRoles(sid, ['planner']); } finally { store.close(); }

    const { status, stdout } = runHook({ session_id: sid }, dir, homeDir);
    assert.equal(status, 0);
    const ctx = stdout?.hookSpecificOutput?.additionalContext || '';
    assert.ok(!ctx.includes('[role:planner]'),
      'role prompt must not be re-injected on a no-op diff');
    assert.match(ctx, /mindwright_recall/,
      'self-recall rule still re-injected on a no-op diff');
  } finally {
    cleanup();
  }
});

// ----- sidecar persistence -----------------------------------------------

test('post-tool-use-inbox refreshes the sidecar to match current DB roles on every firing', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const sid = 'sess-sync-A';
    // Sidecar stale at [planner]; DB now [planner, tester].
    writeSidecarRaw(sid, JSON.stringify(['planner']));
    const store = openStore();
    try { store.setRoles(sid, ['planner', 'tester']); } finally { store.close(); }

    const { status } = runHook({ session_id: sid }, dir);
    assert.equal(status, 0);

    // After the fire, sidecar should reflect the current DB roles so the
    // next firing sees a fresh baseline (no spurious "tester added" notice).
    const path = sidecarPath(sid);
    assert.ok(existsSync(path), 'sidecar file must exist after hook fire');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(persisted.sort(), ['planner', 'tester']);
  } finally {
    cleanup();
  }
});

test('post-tool-use-inbox creates a sidecar even when no roles are assigned', () => {
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const sid = 'sess-empty-A';
    // No sidecar, no roles. Hook still writes [].
    const { status } = runHook({ session_id: sid }, dir);
    assert.equal(status, 0);
    const path = sidecarPath(sid);
    assert.ok(existsSync(path));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), []);
  } finally {
    cleanup();
  }
});

test('post-tool-use-inbox recovers from a corrupted sidecar by re-injecting current roles', () => {
  // Corruption-recovery contract from lib/role-sidecar.js: a malformed
  // sidecar file is treated as []. Every current role becomes "newly added"
  // and is re-injected — better to over-inject once than to miss a role
  // the agent legitimately holds.
  const { dir, cleanup } = setupIsolatedRoot();
  try {
    const sid = 'sess-corrupt-A';
    writeSidecarRaw(sid, '{ not valid json');
    const store = openStore();
    try { store.setRoles(sid, ['planner']); } finally { store.close(); }

    const { status, stdout } = runHook({ session_id: sid }, dir);
    assert.equal(status, 0);
    const ctx = stdout?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /\[role:planner\]/,
      'corrupted sidecar must trigger re-injection of current roles');
  } finally {
    cleanup();
  }
});
