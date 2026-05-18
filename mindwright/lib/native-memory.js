// Reads Claude Code's native per-project memory tree
// (`~/.claude/projects/<encoded-cwd>/memory/*.md`) into seed rows. These are
// LLM-written, not curated truth, so they take the same path as every seed
// source: short-tier `seed` rows the consolidator re-distills. We do NOT map
// frontmatter `metadata.type` onto a category — that's the consolidator's
// job. MEMORY.md is skipped: it is a redundant index of the other files.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { nativeMemoryDir } from './paths.js';

// Minimal dep-free frontmatter reader (schema is shallow: one level of
// nesting, so a YAML lib would be disproportionate). Unrecognized input is
// ignored, never thrown — a malformed file still seeds its body.
// Returns { data, body }.
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

// Coerce a date-ish value to an ISO string, or null. event_ts is COALESCE-
// compared lexicographically against created_at (also ISO), so a raw
// "2026-05-01" or epoch number would sort wrong — must be full ISO.
function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : d.toISOString();
}

// Scan a native-memory dir into seed-row inputs. `memoryDir` is injectable
// (test fixture seam). Each *.md (except MEMORY.md) → one row
// { content, eventTs, sourceRef:"memory:<filename>" }; content is the
// `description` headline + body. eventTs prefers a frontmatter
// date/created/updated field, else file mtime — recency/relevance only.
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
