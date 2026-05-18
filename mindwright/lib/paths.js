// Path resolution for mindwright. All paths are absolute and OS-correct.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { SESSION_ID_PATTERN, MODEL_DAEMON_PROTOCOL } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// EPHEMERAL install dir (changes on plugin update — do not write state here).
// Only LOCATES bundled read-only plugin files (db/migrations, package.json).
export const PLUGIN_ROOT = resolve(__dirname, '..');

// PERSISTENT plugin data dir — survives plugin updates; node_modules + the
// ABI marker live here. Fallback to PLUGIN_ROOT when the env var is absent
// (dev tree / test suite); production always has the env.
export function pluginDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || PLUGIN_ROOT;
}

export function nodeModulesDir() {
  return join(pluginDataDir(), 'node_modules');
}

// Manifest-diff sentinel: bundled package.json ships in the ephemeral
// PLUGIN_ROOT; a copy is written to the persistent data dir after install.
// They differ ⇒ a plugin update changed deps and a reinstall is due (the
// ABI marker can't see this — node_modules holds OLD versions until reinstall).
export function bundledManifestPath() {
  return join(PLUGIN_ROOT, 'package.json');
}
export function installedManifestPath() {
  return join(pluginDataDir(), 'package.json');
}

// Project root is the host process's launch cwd; tests/scripts override via
// MINDWRIGHT_PROJECT_ROOT.
export function projectRoot() {
  return process.env.MINDWRIGHT_PROJECT_ROOT || process.cwd();
}

export function dataDir() {
  return join(projectRoot(), '.claude', 'mindwright');
}

export function dbPath() {
  return join(dataDir(), 'mindwright.db');
}

export function ticketsDir() {
  return join(dataDir(), 'tickets');
}

export function mirrorsDir() {
  return join(dataDir(), 'mirrors');
}

export function migrationsDir() {
  return join(PLUGIN_ROOT, 'db', 'migrations');
}

// wrightward's collaboration dir, read by mindwright for handle/session-id
// resolution. See lib/agents-roster.js for the plugin-independence rationale.
export function collabDir() {
  return join(projectRoot(), '.claude', 'collab');
}

// Claude Code encodes the launch cwd into its per-project transcript-dir name
// by replacing every non-alphanumeric character with '-', preserving OS path
// casing (e.g. C:\Users\x\AI_engineering → C--Users-x-AI-engineering). Single
// source of truth so every consumer agrees on the slug a hook would produce.
export function projectSlug(root = projectRoot()) {
  return root.replace(/[^a-zA-Z0-9]/g, '-');
}

// Base of Claude Code's per-project storage (`~/.claude/projects`).
// MINDWRIGHT_CLAUDE_PROJECTS_DIR is a test-only seam (fixture tree); unset in
// production → real path.
export function claudeProjectsDir() {
  return (
    process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR ||
    join(homedir(), '.claude', 'projects')
  );
}

// The current project's Claude Code transcript directory:
// <claudeProjectsDir>/<encoded-cwd>/. Holds `<sessionId>.jsonl` transcripts.
export function transcriptsDir() {
  return join(claudeProjectsDir(), projectSlug());
}

// Claude Code's native per-project memory dir: <transcriptsDir>/memory/*.md
// (where the global CLAUDE.md memory protocol writes).
export function nativeMemoryDir() {
  return join(transcriptsDir(), 'memory');
}

// Per-session role sidecar dir under .claude/mindwright/sessions/<session_id>/.
// SESSION_ID_PATTERN-gated: session_id flows into a filesystem path, reject
// anything path-unsafe before join() normalizes it.
export function sessionDir(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`mindwright sessionDir: session_id is not path-safe: ${JSON.stringify(sessionId)}`);
  }
  return join(dataDir(), 'sessions', sessionId);
}

// Durable model cache root. transformers.js' OWN default is its package-local
// node_modules/@huggingface/transformers/.cache/ — volatile: a transformers.js
// version bump replaces the package dir, and a dependency reinstall can wipe
// it, forcing a multi-GB re-download. lib/models.js instead sets env.cacheDir
// to this path so weights land under ${CLAUDE_PLUGIN_DATA} (pluginDataDir())
// — the Claude-Code-documented persistent plugin data dir that survives plugin
// updates and dependency reinstalls — but OUTSIDE node_modules, so npm never
// touches it. transformers.js lays models out as <cacheDir>/<org>/<name>/.
// MINDWRIGHT_MODEL_CACHE_DIR overrides the location wholesale — a test seam
// (isolate the cache probe without perturbing pluginDataDir()-derived dep
// resolution) and a user escape hatch to relocate the multi-GB cache off the
// home volume, mirroring modelDaemonSocketPath()'s MINDWRIGHT_MODEL_DAEMON_SOCK
// and Hugging Face's own HF_HOME.
export function modelCacheDir() {
  const override = process.env.MINDWRIGHT_MODEL_CACHE_DIR;
  if (override) return override;
  return join(pluginDataDir(), 'model-cache');
}

// Whether the bge-m3 embedder cache is present on disk. Gates user-facing
// behavior so a recall/dream before setup fails fast instead of stalling on a
// multi-GB model download. The probe is the transformers.js repo dir
// <cacheDir>/Xenova/bge-m3 — its <org>/<name> layout, NOT the Python-hub
// `models--org--name` convention transformers.js never writes.
// MINDWRIGHT_USE_STUB_MODELS=1 short-circuits to "cached" (stubs never touch
// disk and have no lazy load, so the gate must pass).
export function embedderCached() {
  if (process.env.MINDWRIGHT_USE_STUB_MODELS === '1') return true;
  try {
    return existsSync(join(modelCacheDir(), 'Xenova', 'bge-m3'));
  } catch {
    return false;
  }
}

// Machine-global model daemon: one host serves every session across every
// project, rooted at the user's home cache so it survives cwd changes and is
// shared regardless of launch repo. MINDWRIGHT_MODEL_DAEMON_SOCK overrides the
// socket wholesale (test seam / locked-down-home escape hatch); lock + log
// derive from it so all three stay co-located.
function mindwrightCacheDir() {
  return join(homedir(), '.cache', 'mindwright');
}

export function modelDaemonSocketPath() {
  const override = process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
  if (override) return override;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mindwright-modeld-v${MODEL_DAEMON_PROTOCOL}`;
  }
  return join(mindwrightCacheDir(), `modeld-v${MODEL_DAEMON_PROTOCOL}.sock`);
}

// Singleton-election lock: a would-be daemon O_EXCL-creates this. On Windows
// the socket is a named pipe (no FS node), so this is the ONLY cross-process
// election primitive — always a real file.
export function modelDaemonLockPath() {
  const override = process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
  if (override) return `${override}.lock`;
  return join(mindwrightCacheDir(), `modeld-v${MODEL_DAEMON_PROTOCOL}.lock`);
}

export function modelDaemonLogPath() {
  const override = process.env.MINDWRIGHT_MODEL_DAEMON_SOCK;
  if (override) return `${override}.log`;
  return join(mindwrightCacheDir(), 'modeld.log');
}
