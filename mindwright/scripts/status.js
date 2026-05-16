#!/usr/bin/env node
// Diagnostic dump for mindwright. Mirrors the mindwright_status MCP tool but
// runs as a plain script so the user can sanity-check state without an active
// MCP server. Used by /mindwright:status when the daemon may be down.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.js';
import { dataDir, dbPath, mirrorsDir, hfCacheDir, projectRoot, embedderCached } from '../lib/paths.js';
import { isDaemonAlive } from '../lib/daemon-status.js';

function main() {
  const dbExists = existsSync(dbPath());
  const out = {
    project_root: projectRoot(),
    data_dir: dataDir(),
    db_path: dbPath(),
    db_exists: dbExists,
    mirrors_dir: mirrorsDir(),
    hf_cache_dir: hfCacheDir(),
    model_cached: embedderCached(),
    reranker_cached: existsSync(join(hfCacheDir(), 'models--onnx-community--bge-reranker-v2-m3-ONNX')),
    daemon_alive: isDaemonAlive(),
  };

  if (!dbExists) {
    out.short_count = 0;
    out.long_count = 0;
    out.by_category = {};
    out.by_category_scope = {};
    out.last_consolidation = null;
    out.pending_embeds = 0;
    out.oldest_preference_at = null;
    out.consolidators = [];
    out.note = 'database has not been initialized yet — run any mindwright operation to create it';
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
    // Unlike the MCP tool's `consolidator` (filtered to the caller's
    // requester handle), the script has no caller and lists every
    // consolidator-for record so the user can see what's spawned at the
    // project level when debugging dream-cycle issues.
    out.consolidators = store.listConsolidators();
  } finally {
    store.close();
  }

  print(out);
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

// Only run main() when this file is invoked directly (e.g., via the
// /mindwright:status skill), not when imported for unit testing.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
