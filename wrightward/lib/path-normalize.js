'use strict';

const path = require('path');

/**
 * Normalizes a file path for storage in context files, interest index, and bus events.
 *
 * - Backslash → forward slash (POSIX-style)
 * - Strips leading './'
 * - Collapses duplicate separators
 * - Strips trailing '/'
 *
 * Does NOT case-normalize (filesystem case-sensitivity varies).
 * Does NOT resolve `..` segments (use projectRelative for that).
 * Does NOT resolve absolute→relative (callers with a cwd should use projectRelative).
 *
 * This function must be the single source of truth for path format so that
 * the interest index, context file entries, and bus event meta.file all use
 * the same string for the same logical file.
 */
function normalizeFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath;

  let result = filePath.split('\\').join('/');

  // Collapse duplicate separators
  result = result.replace(/\/+/g, '/');

  // Strip leading ./ (possibly repeated: ././foo.ts)
  while (result.startsWith('./')) {
    result = result.slice(2);
  }

  // Strip trailing /
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Canonicalizes an agent-supplied path to the cwd-relative, POSIX-slash form
 * used by context entries, interest-index keys, and bus event meta.file.
 *
 * Handles three differences that normalizeFilePath alone leaves divergent:
 *   - Absolute paths → resolved to relative against projectRoot.
 *   - `..` segments → collapsed via path.resolve (so `src/../evil.ts` and
 *     `evil.ts` converge to the same index key; without this, the interest
 *     index and guard would miss each other).
 *   - Out-of-project paths → rejected (returns null) so callers surface a
 *     useful error rather than storing a key that lookups will never hit.
 *
 * @param {string} projectRoot - Absolute path to the project root (cwd).
 * @param {string} filePath - Agent-supplied path (absolute or relative).
 * @returns {string|null} Canonical POSIX cwd-relative path, or null if invalid.
 */
function projectRelative(projectRoot, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (!projectRoot) return null;
  const abs = path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return normalizeFilePath(rel);
}

module.exports = { normalizeFilePath, projectRelative };
