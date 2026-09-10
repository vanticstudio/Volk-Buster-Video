// Which settings a GUEST may change, and which belong to the owner alone.
//
// Upstream had one user, so every setting was reachable by whoever was at the
// screen — including "forget this server", the brand editor and the whole setup
// terminal. This fork puts strangers in that same UI, so the partition has to
// be real and it has to be enforced on the SERVER. Hiding a row in the drawer
// is a courtesy; the front door refusing the write is the control.
//
// The design decision underneath these tests: the guest list is open and the
// owner list is closed. Anything not recognised as a per-user preference is
// owner-only, so a setting added later is locked down until someone
// deliberately opens it — a new knob can't quietly become a guest-writable one
// by being forgotten.
//
//   npm run test:ownerkeys

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGuestWritable, assertWritable } from '../server/owner-keys.ts';

// ─── What a guest owns ───────────────────────────────────────────────────────

test('a guest may dress their own store', () => {
  // The user model for this fork is "their library, their store, your admin":
  // era, lighting and layout are per-viewer, so these must be writable.
  for (const key of [
    'bb_theme', 'bb_medium', 'bb_arrangement', 'bb_outside',
    'bb_ceiling', 'bb_corner', 'bb_walldecor', 'bb_storefront',
  ]) {
    assert.equal(isGuestWritable(key), true, `${key} is part of a guest's own store`);
  }
});

test('a guest may keep their own per-library toggles', () => {
  // Suffixed keys: bb_carrylib_<id> and friends carry an id after the stem.
  assert.equal(isGuestWritable('bb_carrylib_primary:9f'), true);
});

// ─── What only the owner owns ────────────────────────────────────────────────

test('the shop identity is the owner\'s alone', () => {
  // A guest repainting the store for everyone is the single most obvious abuse
  // of a shared deployment, and the one a viewer would reach for first.
  for (const key of ['bb_logo', 'bb_emblem', 'bb_brand', 'bb_brand_pack']) {
    assert.equal(isGuestWritable(key), false, `${key} is shop identity`);
  }
});

test('connection and setup are the owner\'s alone', () => {
  for (const key of ['provider_kind', 'jellyfin_url', 'jellyfin_token', 'plex_token']) {
    assert.equal(isGuestWritable(key), false, `${key} is connection state`);
  }
});

test('a credential is never writable, whatever it is called', () => {
  // The prefix rule is the backstop: anything outside the bb_ settings family
  // is not a store setting at all, so it can never arrive through this path.
  for (const key of ['plex_machine_id', 'SESSION_SECRET', 'token', 'password', '']) {
    assert.equal(isGuestWritable(key), false, `${key} must never be guest-writable`);
  }
});

// ─── Closed by default ───────────────────────────────────────────────────────

test('an unrecognised bb_ setting is owner-only until someone opens it', () => {
  // The property that makes this safe to live with. A setting added next month
  // and forgotten here is locked, not open — the failure mode is "the owner has
  // to allow it", not "a guest silently got it".
  assert.equal(isGuestWritable('bb_some_setting_added_next_month'), false);
});

// ─── Enforcement ─────────────────────────────────────────────────────────────

test('the owner may write anything in the settings family', () => {
  assert.equal(assertWritable('bb_logo', true).ok, true);
  assert.equal(assertWritable('bb_theme', true).ok, true);
});

test('the owner still may not write outside the settings family', () => {
  // Even an admin does not push credentials through the CONFIG endpoint. They
  // belong to the session, not to a synced preferences blob, and letting them
  // through here would put a token in a row that syncs between devices.
  const res = assertWritable('jellyfin_token', true);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a store setting/i);
});

test('a guest writing an owner-only key is refused with a reason', () => {
  const res = assertWritable('bb_logo', false);
  assert.equal(res.ok, false);
  assert.match(res.reason, /owner/i);
});

test('a guest writing their own key is allowed', () => {
  assert.equal(assertWritable('bb_theme', false).ok, true);
});
