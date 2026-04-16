'use strict';

// INVARIANT: This list is append-only. Reordering or removing an entry will
// re-map every existing session UUID to a different handle on its next
// heartbeat, which breaks peer memory (agent A remembers "bob-42 said X",
// but agent B's row now reads "eve-7"). Snapshot test in
// test/lib/wordlist.test.js pins the first 20 entries for this reason.
// Appending new names at the end is safe; it only widens the pool.
const NAMES = Object.freeze([
  'ada',   'alex',  'amy',   'andy',  'anna',  'ari',   'ava',   'beau',  'ben',   'beth',
  'bo',    'bob',   'buck',  'buffy', 'cal',   'cam',   'cara',  'carl',  'cleo',  'cody',
  'cora',  'dan',   'dane',  'dean',  'dex',   'diana', 'dora',  'drew',  'eli',   'ella',
  'elsa',  'emma',  'enzo',  'eve',   'ezra',  'finn',  'fran',  'fred',  'gabe',  'gene',
  'gia',   'gina',  'hank',  'hans',  'hazel', 'holly', 'hugo',  'iggy',  'iris',  'ivan',
  'ivy',   'jack',  'jade',  'jake',  'jane',  'jay',   'jess',  'joan',  'joe',   'josh',
  'kai',   'kara',  'kate',  'ken',   'kira',  'kurt',  'lana',  'lars',  'lena',  'leo',
  'lila',  'lily',  'luna',  'mae',   'mara',  'max',   'meg',   'milo',  'mira',  'nate',
  'nico',  'nina',  'olga',  'oscar', 'owen',  'pam',   'pat',   'paul',  'pete',  'piper',
  'quinn', 'ray',   'rex',   'rita',  'rory',  'rose',  'ruby',  'sage',  'sam',   'tess'
]);

module.exports = { NAMES };
