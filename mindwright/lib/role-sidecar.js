// Per-session role sidecar. The PostToolUse-on-wrightward_list_inbox hook
// needs to detect role-set changes between firings. We CAN read meta:roles:
// directly from SQLite on every firing, but a sidecar JSON file gives us
// two ergonomic wins:
//   1. The user can `cat .claude/mindwright/sessions/<sid>/role.json` to see
//      what mindwright thinks the role set is — useful when debugging.
//   2. The diff doesn't have to round-trip SQLite on every bus-read; the
//      hook can compare the on-disk sidecar against the DB-fresh role set
//      once per firing.
//
// Sidecar contents: a JSON array of role strings, e.g. ["planner", "tester"].
// Stale sidecars (from a session that exited without SessionEnd) are
// harmless — SessionStart rewrites the sidecar from the DB on every boot,
// overwriting whatever was there.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sessionDir } from './paths.js';

// Path to the sidecar file for `sessionId`. Throws if session_id is not
// path-safe — the caller cannot construct a path-traversal payload.
export function sidecarPath(sessionId) {
  return join(sessionDir(sessionId), 'role.json');
}

// Read the sidecar, returning a normalized role array. Missing file →
// empty array. Corrupted file → empty array (the diff will then treat
// every current role as "newly added" and re-inject them, which is the
// correct recovery behavior — better to over-inject once than to miss a
// role that the agent legitimately holds).
export function readSidecar(sessionId) {
  const path = sidecarPath(sessionId);
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((r) => typeof r === 'string' && r.length > 0);
}

// Write the sidecar atomically-ish (mkdir + writeFileSync). Caller is
// expected to dedupe and sort the role array if they want stable diffs;
// this layer just persists whatever the caller hands in.
export function writeSidecar(sessionId, roles) {
  const path = sidecarPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(roles, null, 2), 'utf8');
}

// Best-effort cleanup. Called by SessionEnd; never throws.
export function removeSidecar(sessionId) {
  try {
    unlinkSync(sidecarPath(sessionId));
  } catch {
    /* missing or already removed — ok */
  }
}

// Compute the set difference between previous and current role arrays.
// `added` = roles in `curr` not in `prev`. `removed` = roles in `prev` not
// in `curr`. Order-independent; duplicates within either array are folded
// to a single entry before the diff runs.
export function diffRoles(prev, curr) {
  const prevSet = new Set(Array.isArray(prev) ? prev : []);
  const currSet = new Set(Array.isArray(curr) ? curr : []);
  const added = [];
  const removed = [];
  for (const r of currSet) {
    if (!prevSet.has(r)) added.push(r);
  }
  for (const r of prevSet) {
    if (!currSet.has(r)) removed.push(r);
  }
  return { added, removed };
}
