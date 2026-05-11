'use strict';

/**
 * Parses a `produces` value into a normalized shape with an entries array.
 *
 * Accepted forms:
 *
 *   "plan"                                  → kind: "single", 1 entry, no extension
 *                                             (legacy / skill: leader picks .md or .json
 *                                             at write time and reports via --artifact-path).
 *
 *   "plan.md"                               → kind: "single", 1 entry, hasExtension=true.
 *                                             Filename is fixed; ${ARTIFACT} resolves to it.
 *
 *   { "metrics": "metrics.json",            → kind: "multi", N entries, each with hasExtension.
 *     "model": "model.bin",                   Each map key is the registry stem; each value is
 *     "log": "train.log" }                    the on-disk filename. ${ARTIFACT.metrics} etc.
 *                                             resolve to per-entry paths. Used for command
 *                                             phases where one script writes several files.
 *
 * Returns null for missing / malformed input. Each entry: { stem, filename, hasExtension }.
 *
 * Registry contract: every entry registers under its stem, so a downstream phase with
 * `consumes: "plan"` keeps working whether the producer wrote `produces: "plan"`,
 * `produces: "plan.md"`, or `produces: { "plan": "plan.md", ... }`.
 */
function parseProduces(produces) {
  if (typeof produces === 'string' && produces.length > 0) {
    const lastDot = produces.lastIndexOf('.');
    if (lastDot > 0 && lastDot < produces.length - 1) {
      return {
        kind: 'single',
        entries: [{
          stem: produces.slice(0, lastDot),
          filename: produces,
          hasExtension: true,
        }],
      };
    }
    return {
      kind: 'single',
      entries: [{
        stem: produces,
        filename: null,
        hasExtension: false,
      }],
    };
  }
  if (produces && typeof produces === 'object' && !Array.isArray(produces)) {
    const entries = [];
    for (const [key, value] of Object.entries(produces)) {
      if (typeof key !== 'string' || !key) continue;
      if (typeof value !== 'string' || !value) continue;
      const lastDot = value.lastIndexOf('.');
      const hasExtension = lastDot > 0 && lastDot < value.length - 1;
      entries.push({
        stem: key,
        filename: value,
        hasExtension,
      });
    }
    if (entries.length === 0) return null;
    return { kind: 'multi', entries };
  }
  return null;
}

/**
 * Stem of a `consumes` value. Consumes is always a string (no map form yet —
 * downstream phases reach for one named entry from the registry).
 */
function consumesStem(consumes) {
  if (typeof consumes !== 'string' || !consumes) return null;
  const parsed = parseProduces(consumes);
  if (!parsed || parsed.kind !== 'single') return null;
  return parsed.entries[0].stem;
}

module.exports = { parseProduces, consumesStem };
