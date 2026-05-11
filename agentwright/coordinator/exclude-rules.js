'use strict';

const path = require('path');

// Directories never snapshotted, never compared in delta computation. Build
// outputs, dependency caches, plugin/CLI state. `.claude` matters because the
// snapshot itself lives there — recursion would be a self-reference loop.
const EXCLUDED_ROOTS = new Set([
  '.claude',
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.vercel',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

// Real secret-bearing env files. `.env.example`, `.env.template`, `.env.sample`
// are intentionally NOT in this set — they are routinely committed as
// documentation, and treating them as secrets would cause phantom diff churn
// (the snapshot side would be missing them while the cwd side still has them).
// Mirrors timewright/lib/excludes.js — the canonical source for which env files
// are real secrets vs. which are documentation.
const SECRET_ENV_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local',
]);

function shouldExclude(relativePath) {
  if (!relativePath) return false;
  const parts = relativePath.split(/[\\/]/);
  if (parts.some(p => EXCLUDED_ROOTS.has(p))) return true;
  const basename = path.basename(relativePath);
  if (SECRET_ENV_NAMES.has(basename)) return true;
  return false;
}

module.exports = {
  EXCLUDED_ROOTS,
  SECRET_ENV_NAMES,
  shouldExclude,
};
