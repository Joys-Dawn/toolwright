// Path resolution for mindwright. All paths are absolute and OS-correct.
// .claude/mindwright/ lives under the project's working directory (cwd at session start);
// model cache piggybacks on transformers.js' default at ~/.cache/huggingface/hub.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { SESSION_ID_PATTERN, MODEL_DAEMON_PROTOCOL } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The plugin root is the parent of lib/. This is the EPHEMERAL install dir:
// Claude Code's plugins-reference states it "changes when the plugin updates …
// treat it as ephemeral and do not write state here." Used only to LOCATE
// bundled, read-only plugin files (db/migrations, the bundled package.json).
export const PLUGIN_ROOT = resolve(__dirname, '..');

// The PERSISTENT plugin data dir. Claude Code exports ${CLAUDE_PLUGIN_DATA}
// (resolved to ~/.claude/plugins/data/<id>/) into every hook process and MCP
// subprocess; it "survives updates" and the docs explicitly recommend it for
// installed dependencies such as node_modules. node_modules + the ABI marker
// live HERE so they persist across plugin updates instead of being wiped every
// update (the entire reason the old wipe-recovery subsystem existed).
//
// Fallback to PLUGIN_ROOT when the env var is absent — the dev tree and the
// whole test suite run without it, so node_modules/marker/manifest resolve
// exactly as before (PLUGIN_ROOT/node_modules). Production always has the env.
export function pluginDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || PLUGIN_ROOT;
}

// Where the native deps are installed and resolved from.
export function nodeModulesDir() {
  return join(pluginDataDir(), 'node_modules');
}

// Manifest-diff sentinel (the documented persistent-dir pattern): the bundled
// package.json ships in the ephemeral PLUGIN_ROOT; a copy is written into the
// persistent data dir after a successful install. When a plugin update changes
// dependencies, the two differ ⇒ a reinstall is due (the ABI marker alone
// cannot see this — node_modules still holds the OLD versions until reinstall).
export function bundledManifestPath() {
  return join(PLUGIN_ROOT, 'package.json');
}
export function installedManifestPath() {
  return join(pluginDataDir(), 'package.json');
}

// The project root is whatever cwd the host process was launched from.
// Tests and scripts can override via the MINDWRIGHT_PROJECT_ROOT env var.
export function projectRoot() {
  return process.env.MINDWRIGHT_PROJECT_ROOT || process.cwd();
}

// Data directory: .claude/mindwright/ under the project root.
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

// wrightward's collaboration dir, owned by wrightward but read by mindwright
// for handle/session-id resolution. Stable file-shape contract — see
// lib/agents-roster.js for the plugin-independence rationale.
export function collabDir() {
  return join(projectRoot(), '.claude', 'collab');
}

// Claude Code encodes the launch cwd into its per-project transcript-dir name
// by replacing every non-alphanumeric character with '-', preserving the OS
// path casing (Windows drive letter stays as the FS reports it). Verified
// against the live tree: C:\Users\yiann\Documents\AI_engineering →
// C--Users-yiann-Documents-AI-engineering. Single source of truth so the
// native-memory scan (lib/native-memory.js) and the transcript bootstrap
// loop (lib/seed-loop.js) agree on the slug a hook would have produced.
export function projectSlug(root = projectRoot()) {
  return root.replace(/[^a-zA-Z0-9]/g, '-');
}

// Base of Claude Code's per-project storage (`~/.claude/projects`). The
// MINDWRIGHT_CLAUDE_PROJECTS_DIR override is a test seam ONLY — it lets the
// seed/native-memory suites point at a fixture tree instead of polluting the
// developer's real ~/.claude/projects. Unset in production → real path.
export function claudeProjectsDir() {
  return (
    process.env.MINDWRIGHT_CLAUDE_PROJECTS_DIR ||
    join(homedir(), '.claude', 'projects')
  );
}

// The current project's Claude Code transcript directory:
// <claudeProjectsDir>/<encoded-cwd>/. Holds `<sessionId>.jsonl` transcripts;
// the transcript-bootstrap loop enumerates *.jsonl here.
export function transcriptsDir() {
  return join(claudeProjectsDir(), projectSlug());
}

// Claude Code's native per-project memory directory:
// <transcriptsDir>/memory/*.md (the `~/.claude/projects/<cwd>/memory` tree
// the global CLAUDE.md memory protocol writes to). Read by the unified seed
// path and re-distilled through consolidation like every other seed source.
export function nativeMemoryDir() {
  return join(transcriptsDir(), 'memory');
}

// Per-session role sidecar dir under .claude/mindwright/sessions/<session_id>/.
// Used by lib/role-sidecar.js so the PostToolUse-on-inbox hook can diff the
// active role set without hitting SQLite.
export function sessionDir(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`mindwright sessionDir: session_id is not path-safe: ${JSON.stringify(sessionId)}`);
  }
  return join(dataDir(), 'sessions', sessionId);
}

// Hugging Face cache; transformers.js defaults to this path. We expose it so
// scripts/setup.js can report whether models are already downloaded.
export function hfCacheDir() {
  return join(homedir(), '.cache', 'huggingface', 'hub');
}

// Whether the bge-m3 embedder cache is present on disk. The check is the
// existence of the Xenova/bge-m3 repo directory under hfCacheDir(). Single
// source of truth for the four places that gate user-facing behavior on this:
// SessionStart hook (setup hint), mindwright_status output, scripts/status,
// and the embed-consuming MCP handlers (recall/retain/retain_fact/merge).
// Without it a /mindwright:dream or /mindwright:recall before /mindwright:setup
// stalls on a 5GB model download — better to fail fast with a clear hint.
//
// MINDWRIGHT_USE_STUB_MODELS=1 short-circuits to "cached" — the stubs don't
// touch disk at all, and the gate exists so the embed path doesn't trigger a
// 5GB lazy load. In stub mode there is no lazy load, so the gate must pass.
export function embedderCached() {
  if (process.env.MINDWRIGHT_USE_STUB_MODELS === '1') return true;
  try {
    return existsSync(join(hfCacheDir(), 'models--Xenova--bge-m3'));
  } catch {
    return false;
  }
}

// Per-session pipe name (Windows named-pipe or POSIX unix-socket).
// session_id originates inside the Claude Code trust boundary but still
// flows into a filesystem path on POSIX — reject anything that would escape
// dataDir() before path.join normalizes it.
export function pipePath(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`mindwright pipePath: session_id is not path-safe: ${JSON.stringify(sessionId)}`);
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mindwright-${sessionId}`;
  }
  return join(dataDir(), `daemon-${sessionId}.sock`);
}

// ── Machine-wide model daemon ─────────────────────────────────────────────
// MACHINE-global, NOT per-project and NOT per-session: one model host serves
// every Claude session across every project on the box. Rooted at the user's
// home cache (same root as the HF model cache) so it survives cwd changes and
// is shared no matter which repo a session is launched from.
//
// MINDWRIGHT_MODEL_DAEMON_SOCK overrides the socket path wholesale — the test
// seam so the suite never binds a real socket under the user's home dir, and
// an escape hatch for locked-down homes. When set, the lock/log derive from
// it so all three stay co-located.
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

// Singleton-election lock. A would-be daemon O_EXCL-creates this; the winner
// writes {pid, protocol, startedAt}. On Windows the socket is a named pipe
// (no filesystem node), so the lock is the ONLY cross-process election
// primitive — always a real file, derived from the cache dir (or alongside
// the override path).
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
