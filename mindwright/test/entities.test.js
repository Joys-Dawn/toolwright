// Unit tests for lib/entities.js. extractEntities feeds the graph retriever
// and is called from consolidator.retainFact for every long-term insert;
// classifyEntity is the single-source classifier for caller-supplied
// entity arrays. Regressions in either degrade retrieval recall silently,
// so we lock in the contract here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, classifyEntity } from '../lib/entities.js';

function kindOf(entities, name) {
  const hit = entities.find((e) => e.name === name);
  return hit ? hit.kind : null;
}

// ---------------------------------------------------------------
// extractEntities — peer handles
// ---------------------------------------------------------------

test('peer-handle pattern matches lowercase-NNNN but does not classify longer digit runs as peer_handle', () => {
  // lena-6697 matches HANDLE_RE (4 digits, word boundary after).
  // foobar-1234567890 has too-long digit run for HANDLE_RE — must NOT be a peer_handle.
  // (It still gets captured by the broader LIBRARY_RE; the contract here is just
  // "the handle regex does not over-grab".)
  const ents = extractEntities('met up with lena-6697 and foobar-1234567890 today');
  assert.equal(kindOf(ents, 'lena-6697'), 'peer_handle');
  assert.notEqual(kindOf(ents, 'foobar-1234567890'), 'peer_handle');
});

test('peer-handle precedence: lena-6697 wins over the library regex match', () => {
  // LIBRARY_RE would also match `lena-6697` (lowercase + hyphen + digits).
  // HANDLE_RE runs first; the entry must come back as peer_handle, not library.
  const ents = extractEntities('paired with lena-6697 on the auth bug');
  assert.equal(kindOf(ents, 'lena-6697'), 'peer_handle');
});

// ---------------------------------------------------------------
// extractEntities — file paths
// ---------------------------------------------------------------

test('file-path pattern matches relative paths with code extensions', () => {
  // FILE_PATH_RE captures the segment from the first word-boundary onward —
  // the leading "./" of a dot-relative path is non-word so the engine starts
  // the match inside the first directory segment. lib/store.js comes through
  // intact; "./src/foo.ts" surfaces as "src/foo.ts". Both must classify as
  // file_path either way.
  const ents = extractEntities('edited lib/store.js and ./src/foo.ts');
  assert.equal(kindOf(ents, 'lib/store.js'), 'file_path');
  assert.equal(kindOf(ents, 'src/foo.ts'), 'file_path');
});

test('file-path pattern rejects bare identifiers without an extension', () => {
  const ents = extractEntities('the foo module is loaded');
  assert.equal(kindOf(ents, 'foo'), null);
});

// ---------------------------------------------------------------
// extractEntities — function names
// ---------------------------------------------------------------

test('function pattern excludes control keywords on the FUNCTION_BLOCKLIST', () => {
  const ents = extractEntities('if (cond) { for (let i=0; i<10; i++) { return i; } }');
  for (const blocked of ['if', 'for', 'return']) {
    assert.equal(kindOf(ents, blocked), null, `${blocked} must be on the blocklist`);
  }
});

test('function pattern enforces the 3-char minimum (no "x(" math-style noise)', () => {
  // FUNCTION_RE requires `[a-z_][a-zA-Z0-9_]{2,}` — name length >= 3.
  const ents = extractEntities('axis x(t) defined by f(t)');
  assert.equal(kindOf(ents, 'x'), null, 'too short — must be ignored');
  assert.equal(kindOf(ents, 'f'), null, 'too short — must be ignored');
});

test('function pattern matches identifiers >=3 chars before (', () => {
  const ents = extractEntities('compute the value via foo(); then bar()');
  assert.equal(kindOf(ents, 'foo'), 'function');
  assert.equal(kindOf(ents, 'bar'), 'function');
});

// ---------------------------------------------------------------
// extractEntities — libraries
// ---------------------------------------------------------------

test('library pattern matches @scope/pkg and bare hyphenated packages', () => {
  const ents = extractEntities('install @huggingface/transformers and react-dom');
  assert.equal(kindOf(ents, '@huggingface/transformers'), 'library');
  assert.equal(kindOf(ents, 'react-dom'), 'library');
});

test('library pattern rejects items on LIBRARY_BLOCKLIST', () => {
  // session-id, top-k, etc. look like libraries to the regex but are
  // domain vocabulary, not packages. They must never appear as kind=library.
  // (tier-1 / agent-message / etc. with numeric or domain-ish suffixes can
  // still be picked up by the broader handle regex — the blocklist only
  // promises they're not surfaced AS libraries, not that they're absent.)
  const ents = extractEntities('the session-id and top-k buckets are routed via agent-message');
  for (const blocked of ['session-id', 'top-k', 'agent-message']) {
    assert.notEqual(kindOf(ents, blocked), 'library', `${blocked} must not classify as library`);
  }
});

test('library pattern rejects common English compounds (best-practices-1)', () => {
  // Regression: the bare-hyphen branch of LIBRARY_RE used to classify any
  // hyphenated lowercase compound as a library. Common English compounds
  // (well-known, open-source, front-end, etc.) showed up in `entities` and
  // would have biased a future v2 graphSearch. Expanded blocklist now
  // catches the highest-frequency offenders.
  const text =
    'this is a well-known open-source pattern for front-end code, ' +
    'a multi-step state machine running in real-time, follow-up notes ' +
    'opt-in by default, cross-platform end-to-end';
  const ents = extractEntities(text);
  for (const blocked of [
    'well-known', 'open-source', 'front-end', 'multi-step',
    'real-time', 'follow-up', 'opt-in', 'cross-platform', 'end-to-end',
  ]) {
    assert.notEqual(kindOf(ents, blocked), 'library',
      `${blocked} must not classify as library — it is an English compound, not a package`);
  }
});

// ---------------------------------------------------------------
// extractEntities — null / empty input safety
// ---------------------------------------------------------------

test('extractEntities("") returns []', () => {
  assert.deepEqual(extractEntities(''), []);
});

test('extractEntities(null) returns []', () => {
  assert.deepEqual(extractEntities(null), []);
});

test('extractEntities(undefined) returns []', () => {
  assert.deepEqual(extractEntities(undefined), []);
});

test('extractEntities(non-string) returns []', () => {
  assert.deepEqual(extractEntities(42), []);
  assert.deepEqual(extractEntities({}), []);
  assert.deepEqual(extractEntities([]), []);
});

// ---------------------------------------------------------------
// classifyEntity — single-name classifier, single source of truth
// ---------------------------------------------------------------

test('classifyEntity matches extractEntities for peer handles', () => {
  const name = 'lena-6697';
  const fromExtract = kindOf(extractEntities(`hello ${name}`), name);
  assert.equal(classifyEntity(name), fromExtract);
  assert.equal(classifyEntity(name), 'peer_handle');
});

test('classifyEntity returns file_path for code extensions and slash paths', () => {
  assert.equal(classifyEntity('lib/store.js'), 'file_path');
  assert.equal(classifyEntity('foo.py'), 'file_path');
  assert.equal(classifyEntity('a/b/c'), 'file_path'); // slash present, no extension
});

test('classifyEntity returns library for @scope/pkg', () => {
  assert.equal(classifyEntity('@huggingface/transformers'), 'library');
});

test('classifyEntity falls back to function for bare identifiers', () => {
  assert.equal(classifyEntity('parseJSON'), 'function');
});

test('classifyEntity handles non-string input safely', () => {
  assert.equal(classifyEntity(null), 'function');
  assert.equal(classifyEntity(undefined), 'function');
  assert.equal(classifyEntity(''), 'function');
  assert.equal(classifyEntity(42), 'function');
});
