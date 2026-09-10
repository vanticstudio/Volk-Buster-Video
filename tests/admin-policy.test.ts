// Store policy: the owner's decisions, applied to every viewer.
//
// Policy is expressed as the store app's OWN settings keys rather than a
// parallel mechanism, so these tests pin the translation. Get it wrong and the
// symptom is silent — the console saves happily, the store ignores it, and
// nothing anywhere reports a problem.
//
//   npm run test:adminpolicy

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, savePolicy, policyKeys, DEFAULT_POLICY } from '../server/admin-config.ts';
import { FrontDoorStore } from '../server/store.ts';
import { deriveKey } from '../server/secrets.ts';

const KEY = deriveKey('admin-policy-test-key-long-enough');
const NOW = 1_757_000_000_000;
const fresh = () => new FrontDoorStore(':memory:', KEY);

// ─── Translation to the store's own settings ────────────────────────────────

test('a hidden library becomes the carry key the store already reads', () => {
  // bb_carrylib_<sourceId>:<libraryId> = '0' is how the app has always meant
  // "this store does not carry that library". Policy rides that rather than
  // inventing a second concept the store would have to learn.
  const keys = policyKeys({ hiddenLibraries: ['machine1:3'], gamesEnabled: false });
  assert.equal(keys['bb_carrylib_machine1:3'], '0');
});

test('visible libraries get NO key at all', () => {
  // Absence has to mean "no opinion". Writing '1' would pin a library ON even
  // after the owner stops hiding it, and would fight the store's own defaults
  // for libraries policy has never heard of.
  const keys = policyKeys({ hiddenLibraries: ['m:1'], gamesEnabled: false });
  assert.equal(keys['bb_carrylib_m:2'], undefined);
  assert.deepEqual(
    Object.keys(keys).filter((k) => k.startsWith('bb_carrylib_')),
    ['bb_carrylib_m:1'],
  );
});

test('the games department is always stated, never implied', () => {
  // Unlike libraries, this one is a single global with a real default, so
  // leaving it out would let a viewer's stale localStorage keep a department
  // the owner has switched off.
  assert.equal(policyKeys({ hiddenLibraries: [], gamesEnabled: true }).bb_games_enabled, '1');
  assert.equal(policyKeys({ hiddenLibraries: [], gamesEnabled: false }).bb_games_enabled, '0');
});

// ─── Persistence ────────────────────────────────────────────────────────────

test('a store with no policy carries everything', () => {
  // The safe default. An owner notices a library they meant to hide far sooner
  // than one that silently vanished.
  const db = fresh();
  assert.deepEqual(loadPolicy(db), DEFAULT_POLICY);
  db.close();
});

test('policy round-trips', () => {
  const db = fresh();
  savePolicy(db, { hiddenLibraries: ['m:3', 'm:7'], gamesEnabled: true }, NOW);
  const back = loadPolicy(db);
  assert.deepEqual(back.hiddenLibraries, ['m:3', 'm:7']);
  assert.equal(back.gamesEnabled, true);
  db.close();
});

test('clearing policy re-stocks the libraries', () => {
  const db = fresh();
  savePolicy(db, { hiddenLibraries: ['m:3'], gamesEnabled: true }, NOW);
  savePolicy(db, { hiddenLibraries: [], gamesEnabled: false }, NOW + 1);
  assert.deepEqual(loadPolicy(db).hiddenLibraries, []);
  assert.equal(Object.keys(policyKeys(loadPolicy(db))).some((k) => k.startsWith('bb_carrylib_')), false);
  db.close();
});

test('a corrupt policy row carries everything rather than throwing', () => {
  // This is read on every document load. A parse error must not be able to take
  // the store down, and hiding nothing is the recoverable direction to fail in.
  const db = fresh();
  db.setPolicy('hidden_libraries', 'not json at all', NOW);
  assert.deepEqual(loadPolicy(db).hiddenLibraries, []);
  db.close();
});

test('policy is not reachable through the per-user config endpoint', () => {
  // It lives in its own table, not a reserved row in user_config — so the
  // endpoint a viewer can call cannot read or overwrite it, whatever key they
  // guess. The first attempt DID smuggle it into user_config, and the foreign
  // key to users refused it; the constraint was right and this is the fix.
  const db = fresh();
  savePolicy(db, { hiddenLibraries: ['m:9'], gamesEnabled: true }, NOW);
  db.upsertUser('42', 'someone', false, NOW);
  assert.deepEqual(db.getConfig('42'), {}, 'a viewer sees nothing of policy');
  db.setConfig('42', 'hidden_libraries', '["m:1"]', NOW);
  assert.deepEqual(loadPolicy(db).hiddenLibraries, ['m:9'], 'and cannot overwrite it');
  db.close();
});

// ─── Signing everyone out ───────────────────────────────────────────────────

test('revoking sessions reports how many went, and leaves users intact', () => {
  // The owner's lever after unsharing a library. Nobody loses ACCESS — anyone
  // still shared with signs back in — so the user rows must survive.
  const db = fresh();
  db.upsertUser('alice', 'alice', false, NOW);
  db.upsertUser('bob', 'bob', false, NOW);
  const a = db.createSession('alice', 'tok', false, NOW);
  db.createSession('bob', 'tok', false, NOW);

  assert.equal(db.deleteAllSessions(), 2);
  assert.equal(db.getSession(a), null);
  // The user row is still there, so their per-user settings survive a revoke.
  db.setConfig('alice', 'bb_theme', 'bb-1990', NOW);
  assert.equal(db.getConfig('alice').bb_theme, 'bb-1990');
  db.close();
});

test('revoking on an empty store is zero, not an error', () => {
  const db = fresh();
  assert.equal(db.deleteAllSessions(), 0);
  db.close();
});
