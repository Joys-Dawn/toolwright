// Regex extractor for named entities in narrative text, for the graph
// retrieval index. Conservative on purpose: false positives pollute the graph
// more than missing entities hurt (the other three retrievers carry recall).

// Peer handle: <lowercase>-<1-4 digits>. Left word boundary so we don't pull
// "ab-1234" out of "foobar-1234567890".
const HANDLE_RE = /\b([a-z]+-\d{1,4})\b/g;
// Non-global twin for membership tests: /g makes .test() stateful (advances
// lastIndex), so keep the /g form for matchAll scans only.
const HANDLE_CLASSIFY_RE = /^[a-z]+-\d{1,4}$/;

// File path: >=1 segment ending in a known code extension.
const FILE_PATH_RE = /\b((?:\.{1,2}\/|~\/|[\w.-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|kt|swift|rb|php|c|h|cc|cpp|hpp|sql|md|json|toml|yml|yaml|sh|ps1|bat|html|css|scss|vue|svelte))\b/g;

// Function reference: identifier followed by `(`. 3-char minimum dodges `x(`
// math noise; control words filtered via FUNCTION_BLOCKLIST below.
const FUNCTION_RE = /\b([a-z_][a-zA-Z0-9_]{2,}|[a-z][a-zA-Z0-9_]{2,}\.[a-zA-Z_][a-zA-Z0-9_]*)\(/g;
const FUNCTION_BLOCKLIST = new Set([
  'if', 'for', 'while', 'switch', 'return', 'typeof', 'instanceof', 'new', 'await',
  'async', 'function', 'console', 'process', 'require', 'import', 'export', 'class',
  'const', 'let', 'var', 'try', 'catch', 'finally', 'throw', 'delete', 'void',
]);

// Library: `@scope/pkg` or hyphenated bare names. The bare-hyphen branch
// can't structurally distinguish real packages (react-dom) from English
// compounds (open-source), so the blocklist below filters the high-frequency
// ones; residual false positives only add a stray `entries` row, never a bad
// retrieval result.
const LIBRARY_RE = /(?:@[a-z0-9-]+\/[a-z0-9._-]+|\b[a-z0-9]+-[a-z0-9-]+\b)/g;
// Non-exhaustive: (a) hyphenated domain vocabulary, (b) high-frequency
// English compounds.
const LIBRARY_BLOCKLIST = new Set([
  'session-id', 'task-ref', 'tier-1', 'tier-2', 'top-k', 'cli-prompt',
  'agent-message', 'user-message', 'file-freed', 'plan-mode', 'short-term', 'long-term',
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
    // Peer-handle-shaped names were already captured by the HANDLE_RE pass.
    if (HANDLE_CLASSIFY_RE.test(name)) continue;
    found.set(name, 'library');
  }

  return [...found.entries()].map(([name, kind]) => ({ name, kind }));
}

// Classify one bare name. Single source of truth for extractEntities and
// direct callers. Order matters: peer-handle before library (library regex
// also accepts lena-6697), and @scope/pkg before the slash-only file_path
// heuristic (else @huggingface/transformers mis-classifies as file_path).
export function classifyEntity(name) {
  if (typeof name !== 'string' || !name) return 'function';
  if (HANDLE_CLASSIFY_RE.test(name)) return 'peer_handle';
  if (/^@[a-z0-9-]+\/[a-z0-9._-]+$/.test(name)) return 'library';
  if (/\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|kt|swift|rb|php|c|h|cc|cpp|hpp|sql|md|json|toml|yml|yaml|sh|ps1|bat|html|css|scss|vue|svelte)$/i.test(name)) return 'file_path';
  if (name.includes('/')) return 'file_path';
  return 'function';
}
