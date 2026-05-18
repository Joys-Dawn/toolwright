// Per-session role sidecar: a JSON array of role strings used by the
// PostToolUse-on-inbox hook to diff the role set without round-tripping
// SQLite each firing (and human-inspectable). Stale sidecars are harmless —
// SessionStart rewrites from the DB on every boot.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sessionDir } from './paths.js';

// Sidecar path; throws via sessionDir() if session_id is not path-safe.
export function sidecarPath(sessionId) {
  return join(sessionDir(sessionId), 'role.json');
}

// Normalized role array; missing/corrupted → [] (the diff then re-injects
// every current role — over-inject once beats missing a held role).
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

// Persist the role array verbatim (caller dedupes/sorts for stable diffs).
export function writeSidecar(sessionId, roles) {
  const path = sidecarPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(roles, null, 2), 'utf8');
}

// Best-effort cleanup (SessionEnd); never throws.
export function removeSidecar(sessionId) {
  try {
    unlinkSync(sidecarPath(sessionId));
  } catch {
    /* missing or already removed — ok */
  }
}

// Set difference: added = curr \ prev, removed = prev \ curr.
// Order-independent; duplicates folded.
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
