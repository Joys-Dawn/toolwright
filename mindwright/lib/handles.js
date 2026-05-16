// Port of wrightward/lib/handles.js#deriveHandle + the NAMES wordlist.
//
// Why a port and not a runtime import: wrightward/package.json is
// `"private": true` with no `exports` map, plugins install into independent
// cache paths under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
// with no stable sibling layout, and toolwright-family memory-rule
// `feedback_plugins_independent.md` forbids cross-plugin coupling. The
// algorithm is small, pure, and stable — a copy gives mindwright a
// guaranteed-same `deriveHandle(sessionId)` for the same UUID without a
// runtime require() into wrightward.
//
// Source of truth: wrightward/lib/handles.js:24-33 (algorithm) and
// wrightward/lib/wordlist.js (NAMES). Keep this file in sync if wrightward
// ever appends to NAMES — but never reorder or remove entries, because
// every persisted handle (DB rows, mirrors, peer messages) derives from this
// table and a re-mapping would silently break referential identity.

import { createHash } from 'node:crypto';

// INVARIANT: This list is append-only. Reordering or removing an entry will
// re-map every existing session UUID to a different handle on its next
// derivation, breaking referential identity in stored memory rows and peer
// references. Mirror of wrightward/lib/wordlist.js#NAMES — keep aligned by
// appending only.
export const NAMES = Object.freeze([
  'ada',   'alex',  'amy',   'andy',  'anna',  'ari',   'ava',   'beau',  'ben',   'beth',
  'bo',    'bob',   'buck',  'buffy', 'cal',   'cam',   'cara',  'carl',  'cleo',  'cody',
  'cora',  'dan',   'dane',  'dean',  'dex',   'diana', 'dora',  'drew',  'eli',   'ella',
  'elsa',  'emma',  'enzo',  'eve',   'ezra',  'finn',  'fran',  'fred',  'gabe',  'gene',
  'gia',   'gina',  'hank',  'hans',  'hazel', 'holly', 'hugo',  'iggy',  'iris',  'ivan',
  'ivy',   'jack',  'jade',  'jake',  'jane',  'jay',   'jess',  'joan',  'joe',   'josh',
  'kai',   'kara',  'kate',  'ken',   'kira',  'kurt',  'lana',  'lars',  'lena',  'leo',
  'lila',  'lily',  'luna',  'mae',   'mara',  'max',   'meg',   'milo',  'mira',  'nate',
  'nico',  'nina',  'olga',  'oscar', 'owen',  'pam',   'pat',   'paul',  'pete',  'piper',
  'quinn', 'ray',   'rex',   'rita',  'rory',  'rose',  'ruby',  'sage',  'sam',   'tess',
]);

const MAX_HANDLE_NUMBER = 9999;
const NAME_COUNT = BigInt(NAMES.length);
const NUMBER_RANGE = BigInt(MAX_HANDLE_NUMBER + 1);

// Matches wrightward/lib/constants.js#HANDLE_PATTERN. Used by callers that
// need to decide "is this input a handle or a UUID?" before resolving.
export const HANDLE_PATTERN = /^[a-z]+-\d{1,4}$/;

// Deterministic handle for a session UUID. Pure — no I/O, no global state.
// Same input always yields the same output as long as NAMES stays stable.
//
// Uses the first 48 bits of sha256(sessionId) (12 hex chars) as an unsigned
// integer N, then:
//   name   = NAMES[N mod |NAMES|]
//   number = (N div |NAMES|) mod 10000
//
// BigInt arithmetic avoids Number's 53-bit precision ceiling on the 48-bit
// intermediate. Collision math: 100 names × 10000 numbers = 1M slots, so
// birthday-paradox 50%-collision point is ~1183 concurrent sessions —
// orders of magnitude above realistic load.
export function deriveHandle(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('deriveHandle requires a non-empty string sessionId');
  }
  const hex = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  const big = BigInt('0x' + hex.slice(0, 12));
  const nameIdx = Number(big % NAME_COUNT);
  const number = Number((big / NAME_COUNT) % NUMBER_RANGE);
  return NAMES[nameIdx] + '-' + number;
}

// True iff `str` has handle shape. Does NOT check the name against NAMES or
// against any live roster — cheap first-pass routing only.
export function validateHandle(str) {
  return typeof str === 'string' && HANDLE_PATTERN.test(str);
}
