// Regex extractor for named entities in narrative text. Used by the consolidator
// to build the graph retrieval index. Conservative on purpose: false positives
// pollute the graph more than they help; missing things just means slightly
// weaker graph recall (the other three retrievers carry the load).

// Peer handle: <lowercase>-<1-4 digits>. Mirrors wrightward HANDLE_PATTERN.
// We require a word boundary on the left so we don't pull "ab-1234" out of
// "foobar-1234567890" or random IDs.
const HANDLE_RE = /\b([a-z]+-\d{1,4})\b/g;
// Non-global twin used for one-shot membership tests. Using HANDLE_RE.test()
// is a foot-gun because the /g flag makes test() stateful (advances
// lastIndex). Keep the /g form only for matchAll scans.
const HANDLE_CLASSIFY_RE = /^[a-z]+-\d{1,4}$/;

// File path: at least one segment, ends with a known code extension, or
// starts with `./` / `/` / `~/` / `<a-z>/`. Greedy on the basename, capped to
// stop at whitespace / quotes / parens / brackets / colons / commas / backticks.
const FILE_PATH_RE = /\b((?:\.{1,2}\/|~\/|[\w.-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|kt|swift|rb|php|c|h|cc|cpp|hpp|sql|md|json|toml|yml|yaml|sh|ps1|bat|html|css|scss|vue|svelte))\b/g;

// Function reference: identifier followed by `(`. Lower-camel or snake;
// requires preceding word boundary so we don't pick up "is(" inside "axis(".
// We avoid matching control words (`if`, `while`, `for`, etc.) and anything
// shorter than three chars (heuristic to dodge `x(` math noise).
const FUNCTION_RE = /\b([a-z_][a-zA-Z0-9_]{2,}|[a-z][a-zA-Z0-9_]{2,}\.[a-zA-Z_][a-zA-Z0-9_]*)\(/g;
const FUNCTION_BLOCKLIST = new Set([
  'if', 'for', 'while', 'switch', 'return', 'typeof', 'instanceof', 'new', 'await',
  'async', 'function', 'console', 'process', 'require', 'import', 'export', 'class',
  'const', 'let', 'var', 'try', 'catch', 'finally', 'throw', 'delete', 'void',
]);

// Library: `@scope/pkg` or bare lowercase package names with a hyphen.
// We require the hyphen for bare names so we don't match every English word.
//
// CWE-1023 (Incomplete Comparison with Missing Factors): the bare-hyphen
// branch matches both real packages (react-dom, vue-router) and any
// hyphenated English compound (well-known, open-source, front-end).
// There is no clean structural distinction. Mitigations applied:
//   - blocklist below covers the highest-frequency English / domain
//     compounds we've seen in narrative text.
//   - graphSearch is a v1 stub returning [] (DESIGN.md), so the cost of
//     a residual false positive is just a row in `entries`, never an
//     incorrect retrieval result. When the v2 graph lights up this
//     blocklist should grow with real-world telemetry.
const LIBRARY_RE = /(?:@[a-z0-9-]+\/[a-z0-9._-]+|\b[a-z0-9]+-[a-z0-9-]+\b)/g;
// Common false-positives we never want as a library. Two categories:
//  (a) mindwright/wrightward domain vocabulary that happens to be hyphenated;
//  (b) high-frequency English compounds. The list is not exhaustive — it's
//      the visible peak of a long tail. We accept some residual noise.
const LIBRARY_BLOCKLIST = new Set([
  // domain vocabulary
  'session-id', 'task-ref', 'tier-1', 'tier-2', 'top-k', 'cli-prompt',
  'agent-message', 'user-message', 'file-freed', 'plan-mode', 'short-term', 'long-term',
  // common English compounds (rough frequency order from prose seen in our corpora)
  'well-known', 'open-source', 'front-end', 'back-end', 'real-time', 'multi-step',
  'high-level', 'low-level', 'end-to-end', 'multi-line',
  'single-line', 'cross-platform', 'cross-process', 'cross-session', 'self-hosted',
  'right-hand', 'left-hand', 'second-hand', 'first-class', 'second-class', 'third-party',
  'first-party', 'multi-tenant', 'single-tenant', 'read-only', 'write-only',
  'opt-in', 'opt-out', 'follow-up', 'follow-through', 'in-place', 'out-of-band',
  'in-band', 'in-flight', 'in-progress', 'in-process', 'top-level', 'bottom-up',
  'top-down', 'multi-pass', 'single-pass', 'one-shot', 'one-off', 'one-time',
  'two-way', 'one-way', 'multi-way', 'side-effect', 'side-channel', 'edge-case',
]);

export function extractEntities(text) {
  if (typeof text !== 'string' || !text) return [];

  const found = new Map(); // key=name → value=kind (first kind wins)

  for (const m of text.matchAll(HANDLE_RE)) {
    found.set(m[1], 'peer_handle');
  }
  for (const m of text.matchAll(FILE_PATH_RE)) {
    if (!found.has(m[1])) found.set(m[1], 'file_path');
  }
  for (const m of text.matchAll(FUNCTION_RE)) {
    const name = m[1];
    if (FUNCTION_BLOCKLIST.has(name.toLowerCase())) continue;
    if (!found.has(name)) found.set(name, 'function');
  }
  for (const m of text.matchAll(LIBRARY_RE)) {
    const name = m[0];
    if (found.has(name)) continue;
    if (LIBRARY_BLOCKLIST.has(name.toLowerCase())) continue;
    // If the match also looks like a peer handle (e.g. "lena-6697"), the
    // HANDLE_RE pass above already captured it.
    if (HANDLE_CLASSIFY_RE.test(name)) continue;
    found.set(name, 'library');
  }

  return [...found.entries()].map(([name, kind]) => ({ name, kind }));
}

// Classify a single bare name into one of the four entity kinds. Single
// source of truth used by both extractEntities (free-text scan) and direct
// callers (e.g. the consolidator handling caller-supplied entity arrays).
// Order matters: peer-handle pattern matches before library because the
// library regex would also accept lena-6697 as "<lowercase>-<...>".
export function classifyEntity(name) {
  if (typeof name !== 'string' || !name) return 'function';
  // peer handle: <lowercase>-<1-4 digits>
  if (HANDLE_CLASSIFY_RE.test(name)) return 'peer_handle';
  // library (@scope/pkg) must run BEFORE the slash-only file_path heuristic
  // — otherwise `@huggingface/transformers` (slash + no code extension) gets
  // mis-classified as file_path.
  if (/^@[a-z0-9-]+\/[a-z0-9._-]+$/.test(name)) return 'library';
  // file path: ends with a code extension OR contains a path separator
  if (/\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|kt|swift|rb|php|c|h|cc|cpp|hpp|sql|md|json|toml|yml|yaml|sh|ps1|bat|html|css|scss|vue|svelte)$/i.test(name)) return 'file_path';
  if (name.includes('/')) return 'file_path';
  return 'function';
}
