'use strict';

const path = require('path');

// Directories we never snapshot or restore. These are either generated output
// (build artifacts), dependency caches, or Claude/plugin state that must not
// be rewound. `.claude` is critical — we must not recurse into our own
// snapshot directory under .claude/timewright/.
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
  '.ruff_cache'
]);

// Real secret-bearing env files. We deliberately do NOT exclude
// `.env.example`, `.env.template`, `.env.sample`, etc. — those are routinely
// committed to repos as documentation and the user expects /undo to restore
// Claude's changes to them like any other file. Actual secret files should
// be in `.gitignore` anyway, in which case the snapshot's git ls-files walk
// filters them out already; this explicit set is belt-and-braces.
const SECRET_ENV_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local'
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
  shouldExclude
};
