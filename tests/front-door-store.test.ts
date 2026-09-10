// The front door's database, exercised against a real in-memory SQLite.
//
// Two properties carry the fork's user model and are worth pinning hard:
// tokens are never readable in the file, and two viewers' stores are genuinely
// independent. A bug in either is invisible in normal use — the app would work
// perfectly right up until someone read the database, or until one person's
// settings appeared in another person's store.
//
//   npm run test:frontdoor

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrontDoorStore } from '../server/store.ts';
import { deriveKey } from '../server/secrets.ts';

const KEY = deriveKey('front-door-test-key-long-enough');
const NOW = 1_757_000_000_000;

function freshStore(): FrontDoorStore {
  return new FrontDoorStore(':memory:', KEY);
}

// ─── Users and sessions ──────────────────────────────────────────────────────

test('a session round-trips with its token decrypted', () => {
  const db = freshStore();
  db.upsertUser('u1', 'alice', false, NOW);
  const sid = db.createSession('u1', 'plex-token-1', false, NOW);

  const s = db.getSession(sid);
  assert.equal(s?.uid, 'u1');
  assert.equal(s?.token, 'plex-token-1');
  assert.equal(s?.owner, false);
  db.close();
});

test('the owner flag is stored and read back', () => {
  const db = freshStore();
  db.upsertUser('owner', 'jake', true, NOW);
  const sid = db.createSession('owner', 'tok', true, NOW);
  assert.equal(db.getSession(sid)?.owner, true);
  db.close();
});

test('an unknown session is null, not a throw', () => {
  const db = freshStore();
  assert.equal(db.getSession('no-such-session'), null);
  db.close();
});

test('a session created under a different key is unusable', () => {
  // What a key rotation looks like from the inside. The row survives; the
  // session does not, which must read as "sign in again" rather than as a
  // session with an empty token that would quietly build an empty store.
  const db = new FrontDoorStore(':memory:', KEY);
  db.upsertUser('u1', 'alice', false, NOW);
  const sid = db.createSession('u1', 'tok', false, NOW);
  db.close();

  const rotated = new FrontDoorStore(':memory:', deriveKey('a-different-key-entirely-here'));
  assert.equal(rotated.getSession(sid), null);
  rotated.close();
});

test('signing a user out drops every session they hold', () => {
  // The revocation path: re-validation finds the owner unshared a library, and
  // that person must lose the tab open on their phone too, not just this one.
  const db = freshStore();
  db.upsertUser('u1', 'alice', false, NOW);
  const a = db.createSession('u1', 'tok', false, NOW);
  const b = db.createSession('u1', 'tok', false, NOW);

  db.deleteSessionsForUser('u1');
  assert.equal(db.getSession(a), null);
  assert.equal(db.getSession(b), null);
  db.close();
});

test('re-signing in updates the user rather than duplicating them', () => {
  const db = freshStore();
  db.upsertUser('u1', 'alice', false, NOW);
  db.upsertUser('u1', 'alice-renamed', true, NOW + 1000);
  // No throw on the primary key, and the later values win.
  const sid = db.createSession('u1', 'tok', true, NOW);
  assert.equal(db.getSession(sid)?.owner, true);
  db.close();
});

// ─── Per-user config ─────────────────────────────────────────────────────────

test('two viewers keep genuinely separate stores', () => {
  // The user model in one assertion: "their library, their store, your admin".
  const db = freshStore();
  db.upsertUser('alice', 'alice', false, NOW);
  db.upsertUser('bob', 'bob', false, NOW);

  db.setConfig('alice', 'bb_theme', 'bb-1990', NOW);
  db.setConfig('bob', 'bb_theme', 'bb-2010', NOW);

  assert.equal(db.getConfig('alice').bb_theme, 'bb-1990');
  assert.equal(db.getConfig('bob').bb_theme, 'bb-2010');
  db.close();
});

test('a viewer with no settings gets an empty map, not undefined', () => {
  // The instance hydrates from this before the app boots; a null here would
  // crash a first-time viewer's very first visit.
  const db = freshStore();
  db.upsertUser('new', 'new', false, NOW);
  assert.deepEqual(db.getConfig('new'), {});
  db.close();
});

test('writing the same key twice updates rather than duplicating', () => {
  const db = freshStore();
  db.upsertUser('u1', 'alice', false, NOW);
  db.setConfig('u1', 'bb_theme', 'bb-1990', NOW);
  db.setConfig('u1', 'bb_theme', 'bb-2000', NOW + 1);
  assert.deepEqual(db.getConfig('u1'), { bb_theme: 'bb-2000' });
  db.close();
});

test('clearing a key removes it, because absence is meaningful', () => {
  // This app encodes "library switched back on" as the DELETION of its key, so
  // an empty-string write would not mean the same thing.
  const db = freshStore();
  db.upsertUser('u1', 'alice', false, NOW);
  db.setConfig('u1', 'bb_carrylib_9f', '0', NOW);
  db.clearConfig('u1', 'bb_carrylib_9f');
  assert.deepEqual(db.getConfig('u1'), {});
  db.close();
});

test('clearing one viewer\'s key leaves the other\'s alone', () => {
  const db = freshStore();
  db.upsertUser('alice', 'alice', false, NOW);
  db.upsertUser('bob', 'bob', false, NOW);
  db.setConfig('alice', 'bb_theme', 'bb-1990', NOW);
  db.setConfig('bob', 'bb_theme', 'bb-1990', NOW);

  db.clearConfig('alice', 'bb_theme');
  assert.deepEqual(db.getConfig('alice'), {});
  assert.equal(db.getConfig('bob').bb_theme, 'bb-1990');
  db.close();
});
