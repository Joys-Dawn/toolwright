// Tests for the consolidator self-spawn guard
// (lib/seed-trigger.js#isConsolidatorSession).
//
// The SessionStart transcript-bootstrap auto-trigger that this module used to
// host (shouldAutoSeed / maybeAutoSeed) has been removed — seeding is manual
// only. What remains is the guard the Stop hook's cap-nudge path consumes so
// it never spawns a consolidator from inside a consolidator session.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../lib/store.js';
import { isConsolidatorSession } from '../../lib/seed-trigger.js';

const SESS = '33333333-3333-4333-8333-333333333333';

// node --test runs every file in one process; restore the one env var this
// guard reads so a leak can't silently flip sibling suites.
let envSnapshot;
beforeEach(() => {
  envSnapshot = process.env.MINDWRIGHT_IS_CONSOLIDATOR;
  delete process.env.MINDWRIGHT_IS_CONSOLIDATOR;
});
afterEach(() => {
  if (envSnapshot === undefined) delete process.env.MINDWRIGHT_IS_CONSOLIDATOR;
  else process.env.MINDWRIGHT_IS_CONSOLIDATOR = envSnapshot;
});

async function withStore(fn) {
  const prevRoot = process.env.MINDWRIGHT_PROJECT_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'mindwright-consguard-'));
  process.env.MINDWRIGHT_PROJECT_ROOT = root;
  const store = openStore();
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    if (prevRoot === undefined) delete process.env.MINDWRIGHT_PROJECT_ROOT;
    else process.env.MINDWRIGHT_PROJECT_ROOT = prevRoot;
  }
}

test('a plain session is not a consolidator', async () => {
  await withStore(async (store) => {
    assert.equal(isConsolidatorSession(store, SESS), false);
  });
});

test('MINDWRIGHT_IS_CONSOLIDATOR=1 → true (env sentinel, primary signal)', async () => {
  await withStore(async (store) => {
    process.env.MINDWRIGHT_IS_CONSOLIDATOR = '1';
    assert.equal(isConsolidatorSession(store, SESS), true);
  });
});

test('the consolidator role (no env var) → true (secondary signal)', async () => {
  await withStore(async (store) => {
    store.setRoles(SESS, ['consolidator']);
    assert.equal(isConsolidatorSession(store, SESS), true);
  });
});

test('a getRoles failure is swallowed → false (never throws into the Stop hook)', () => {
  const brokenStore = { getRoles() { throw new Error('simulated DB failure'); } };
  assert.doesNotThrow(() => isConsolidatorSession(brokenStore, SESS));
  assert.equal(isConsolidatorSession(brokenStore, SESS), false);
});
