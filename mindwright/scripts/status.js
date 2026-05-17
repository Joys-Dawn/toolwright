#!/usr/bin/env node
// Diagnostic dump for mindwright, used by /mindwright:status. Mirrors the
// mindwright_status tool but runs as a plain script so the user can
// sanity-check state even when the model daemon is down.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, dbPath, mirrorsDir, hfCacheDir, projectRoot, embedderCached } from '../lib/paths.js';
import { isDaemonAlive } from '../lib/daemon-status.js';
import { depsInstalled } from '../lib/ready.js';
import { maybeAutoInstall, installLogPath } from '../lib/auto-setup.js';

async function main() {
  // Dependency gate: quarantine openStore() (the only native-dep import)
  // behind a dep-free check, emit a status built only from dep-free signals,
  // and trigger the background install so a later /mindwright:status comes up
  // fully on its own.
  if (!depsInstalled()) {
    maybeAutoInstall();
    print({
      ...baseStatus(),
      ...zeroCounts(),
      note: `native dependencies not installed yet — a one-time background install was triggered (log: ${installLogPath()}); memory features activate automatically once it completes`,
    });
    return;
  }
  const { openStore } = await import('../lib/store.js');
  const out = baseStatus();

  if (!out.db_exists) {
    Object.assign(out, zeroCounts(), {
      note: 'database has not been initialized yet — run any mindwright operation to create it',
    });
    print(out);
    return;
  }

  const store = openStore();
  try {
    const byTier = store.countByTier();
    const byCategoryRows = store.countByCategory();
    const by_category = Object.fromEntries(byCategoryRows.map((r) => [r.category, r.n]));
    const byCatScopeRows = store.countByCategoryScope();
    const by_category_scope = Object.fromEntries(
      byCatScopeRows.map((r) => [`${r.category}/${r.scope}`, r.n]),
    );
    const last = store.lastConsolidation();
    out.short_count = byTier.short;
    out.long_count = byTier.long;
    out.by_category = by_category;
    out.by_category_scope = by_category_scope;
    out.last_consolidation = last ? last.fired_at : null;
    out.pending_embeds = store.countPendingEmbeds();
    out.oldest_preference_at = store.oldestUserPreference();
    // The script has no caller, so (unlike the tool, which filters to the
    // caller's requester handle) it lists every consolidator-for record for
    // debugging dream-cycle issues.
    out.consolidators = store.listConsolidators();
  } finally {
    store.close();
  }

  print(out);
}

// Single source of truth for the status payload shape so all three branches
// (deps-missing, db-not-initialized, live) can't drift. Dep-free by
// construction — safe to call from the pre-dependency-gate branch.
function baseStatus() {
  return {
    project_root: projectRoot(),
    data_dir: dataDir(),
    db_path: dbPath(),
    db_exists: existsSync(dbPath()),
    mirrors_dir: mirrorsDir(),
    hf_cache_dir: hfCacheDir(),
    model_cached: embedderCached(),
    reranker_cached: existsSync(join(hfCacheDir(), 'models--onnx-community--bge-reranker-v2-m3-ONNX')),
    daemon_alive: isDaemonAlive(),
  };
}

function zeroCounts() {
  return {
    short_count: 0,
    long_count: 0,
    by_category: {},
    by_category_scope: {},
    last_consolidation: null,
    pending_embeds: 0,
    oldest_preference_at: null,
    consolidators: [],
  };
}

function print(out) {
  // Human-readable on stderr for terminal, JSON on stdout for piping.
  const lines = [
    `mindwright status`,
    `  project root:      ${out.project_root}`,
    `  data dir:          ${out.data_dir}`,
    `  db path:           ${out.db_path}`,
    `  db exists:         ${out.db_exists}`,
    `  mirrors dir:       ${out.mirrors_dir}`,
    `  hf cache:          ${out.hf_cache_dir}`,
    `  embedder cached:   ${out.model_cached}`,
    `  reranker cached:   ${out.reranker_cached}`,
    `  daemon alive:      ${out.daemon_alive}`,
    `  short_count:       ${out.short_count}`,
    `  long_count:        ${out.long_count}`,
    `  by_category:       ${JSON.stringify(out.by_category)}`,
    `  by_category_scope: ${JSON.stringify(out.by_category_scope)}`,
    `  last consolidation:${out.last_consolidation ?? 'never'}`,
    `  pending_embeds:    ${out.pending_embeds}`,
    `  oldest pref at:    ${out.oldest_preference_at ?? 'none'}`,
    `  consolidators:     ${
      out.consolidators && out.consolidators.length
        ? out.consolidators.map((c) =>
            `${c.requester_handle} → ${c.session_id} (last_spawn=${c.last_spawn ?? 'never'})`
          ).join('; ')
        : 'none'
    }`,
  ];
  if (out.note) lines.push(`  note:              ${out.note}`);
  process.stderr.write(lines.join('\n') + '\n');
  process.stdout.write(JSON.stringify(out) + '\n');
}

// Only run main() when invoked directly, not on import (unit tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`mindwright status crashed: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}
