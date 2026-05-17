// Port of wrightward's deriveHandle + NAMES wordlist. A port, not a runtime
// import, because plugin independence forbids cross-plugin coupling and the
// algorithm is small/pure/stable. Mirror of wrightward's wordlist — keep in
// sync by APPENDING only; reorder/remove re-maps every persisted handle and
// silently breaks referential identity.

import { createHash } from 'node:crypto';

// INVARIANT: append-only — reordering/removing re-maps every session UUID.
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

// Mirrors wrightward's HANDLE_PATTERN — handle-vs-UUID routing.
export const HANDLE_PATTERN = /^[a-z]+-\d{1,4}$/;

// Deterministic, pure handle for a session UUID. First 48 bits of
// sha256(sessionId) as N → name=NAMES[N mod |NAMES|],
// number=(N div |NAMES|) mod 10000. BigInt avoids Number's 53-bit ceiling on
// the 48-bit intermediate; 1M slots ⇒ ~1183-session 50%-collision point.
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
