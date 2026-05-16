// Reads Claude Code's native per-project memory tree
// (`~/.claude/projects/<encoded-cwd>/memory/*.md`) into seed rows for the
// unified seed path. These files are LLM-written by the global CLAUDE.md
// memory protocol — they are NOT hand-curated truth, so they take exactly
// the same path as every other seed source: short-tier `seed` rows that the
// consolidator re-distills. We deliberately do NOT map the frontmatter
// `metadata.type` onto an entries.category here — categorization is the
// consolidator's job (DESIGN.md "auto-seed by folding into consolidation").
//
// MEMORY.md is skipped: it is the human-readable index of one-line pointers,
// fully redundant with the individual fact files it points at — seeding it
// would just duplicate every other row's gist with no new signal.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { nativeMemoryDir } from './paths.js';

// Minimal, dependency-free frontmatter reader. The memory protocol's schema
// is shallow (`name`, `description`, `metadata.type` — one level of nesting)
// so a YAML library would be disproportionate. Anything we don't recognize
// is ignored rather than erroring: a malformed or schema-drifted file should
// still seed its body, never crash the whole scan.
//
// Returns { data, body }. `data` holds the parsed scalar keys plus a nested
// `metadata` object when present; `body` is everything after the closing
// fence (or the whole file when there is no frontmatter).
function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  // Frontmatter must be the very first thing in the file: `---\n ... \n---`.
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  const data = {};
  let nestKey = null;
  for (const lineRaw of m[1].split(/\r?\n/)) {
    if (!lineRaw.trim()) continue;
    const indented = /^\s/.test(lineRaw);
    const kv = /^\s*([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(lineRaw);
    if (!kv) { nestKey = null; continue; }
    const key = kv[1];
    const val = kv[2].trim().replace(/^["']|["']$/g, '');
    if (indented && nestKey) {
      // One level of nesting (`metadata:` → `  type: ...`).
      if (typeof data[nestKey] !== 'object' || data[nestKey] === null) {
        data[nestKey] = {};
      }
      data[nestKey][key] = val;
    } else if (val === '') {
      // `key:` with no inline value opens a nested block.
      data[key] = {};
      nestKey = key;
    } else {
      data[key] = val;
      nestKey = null;
    }
  }
  const body = text.slice(m[0].length).trim();
  return { data, body };
}

// Coerce a frontmatter date-ish value (or a file mtime Date) to an ISO
// string, or null when it isn't a real date. event_ts is stored as ISO text
// and COALESCE-compared lexicographically against created_at (also ISO), so
// the representation must match exactly — a raw "2026-05-01" or epoch number
// would sort wrong against a full ISO timestamp.
function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : d.toISOString();
}

// Scan a native-memory directory into seed-row inputs. `memoryDir` is
// injectable so unit tests point at a fixture tree; production / the
// seed-from-repo script call with no argument and get the real
// ~/.claude/projects/<encoded-cwd>/memory path.
//
// Each *.md (except MEMORY.md) becomes one row:
//   { content, eventTs, sourceRef:"memory:<filename>" }
// content = the one-line `description` (when present) followed by the body,
// so the consolidator gets both the headline and the detail to re-distill.
// eventTs prefers a frontmatter `date`/`created`/`updated` field, else the
// file's mtime — "when this memory actually happened", per the governing
// event_ts invariant (recency/relevance only; lifecycle stays on created_at).
export function collectNativeMemory(memoryDir = nativeMemoryDir()) {
  let names;
  try {
    names = readdirSync(memoryDir);
  } catch (e) {
    // No native memory tree for this project (the common fresh-install case)
    // — not an error, just nothing to seed.
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }

  const out = [];
  // Deterministic order: readdir order is filesystem-defined, but seeding
  // and the tests both want a stable sequence.
  for (const name of names.slice().sort()) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.toLowerCase() === 'memory.md') continue; // the index, redundant

    const filePath = join(memoryDir, name);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue; // raced deletion / dangling entry — skip, don't crash the scan
    }
    if (!stat.isFile()) continue;

    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const { data, body } = parseFrontmatter(raw);
    const description =
      typeof data.description === 'string' ? data.description.trim() : '';
    const content = description ? `${description}\n\n${body}`.trim() : body.trim();
    if (!content) continue; // empty file → no signal

    const fmDate =
      toIso(data.date) || toIso(data.created) || toIso(data.updated);
    const eventTs = fmDate || toIso(stat.mtime);

    out.push({
      content,
      eventTs,
      sourceRef: `memory:${basename(name)}`,
    });
  }
  return out;
}
