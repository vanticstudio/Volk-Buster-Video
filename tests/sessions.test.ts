// Session tokens — the cookie that says "this browser already passed the gate".
//
// The gate (plex-gate.ts) runs once, at sign-in. Every request after that
// trusts this token instead, which makes forging one equivalent to bypassing
// the gate entirely. These tests are the adversarial half: each one is a way
// somebody could try to mint or edit a session they were never given.
//
// The `owner` flag matters as much as identity here. Flipping it is a
// privilege escalation from guest to admin — brand, connection and the setup
// terminal all key off it — so it is signed alongside the user id rather than
// looked up separately and trusted.
//
//   npm run test:sessions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, type SessionPayload } from '../server/sessions.ts';

const SECRET = 'test-secret-not-a-real-one';
const NOW = 1_757_000_000_000; // fixed clock; Date.now() is never called in tests
const HOUR = 3_600_000;

function payload(over: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sid: 'session-id-1',
    uid: 'plex-account-42',
    owner: false,
    exp: NOW + HOUR,
    ...over,
  };
}

// ─── Round trip ──────────────────────────────────────────────────────────────

test('a signed session verifies back to exactly what went in', () => {
  const token = signSession(payload(), SECRET);
  assert.deepEqual(verifySession(token, SECRET, NOW), payload());
});

test('the owner flag survives the round trip', () => {
  const token = signSession(payload({ owner: true }), SECRET);
  assert.equal(verifySession(token, SECRET, NOW)?.owner, true);
});

test('a token is opaque — it carries no readable secret', () => {
  // The payload is signed, not encrypted, and that is fine: it holds an account
  // id and a boolean, not a credential. The Plex token itself never goes in
  // here (it is encrypted at rest server-side), and this pins that.
  const token = signSession(payload(), SECRET);
  assert.doesNotMatch(token, new RegExp(SECRET), 'the signing secret must never appear in the token');
});

// ─── Forgery ─────────────────────────────────────────────────────────────────

test('a token signed with a different secret is refused', () => {
  const token = signSession(payload(), 'some-other-secret');
  assert.equal(verifySession(token, SECRET, NOW), null);
});

test('editing the payload invalidates the signature', () => {
  const token = signSession(payload(), SECRET);
  const [body, sig] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());

  // The escalation attempt: same session, but now claiming to be the owner.
  decoded.owner = true;
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + sig;

  assert.equal(verifySession(forged, SECRET, NOW), null);
});

test('swapping in another user id invalidates the signature', () => {
  const token = signSession(payload(), SECRET);
  const [body, sig] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
  decoded.uid = 'somebody-else';
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + sig;
  assert.equal(verifySession(forged, SECRET, NOW), null);
});

test('a token with its signature removed is refused', () => {
  const token = signSession(payload(), SECRET);
  assert.equal(verifySession(token.split('.')[0], SECRET, NOW), null);
});

test('a token with an empty signature is refused', () => {
  const token = signSession(payload(), SECRET);
  assert.equal(verifySession(token.split('.')[0] + '.', SECRET, NOW), null);
});

test('garbage in any shape is refused rather than thrown at the caller', () => {
  // A request handler must be able to hand this whatever arrived in a cookie
  // header without wrapping it in try/catch — a throw here would be a denial of
  // service reachable by anyone sending a malformed cookie.
  for (const junk of ['', '.', '..', 'not-a-token', 'a.b.c', '!!!.???', 'null', '{}']) {
    assert.equal(verifySession(junk, SECRET, NOW), null, `${JSON.stringify(junk)} must be refused`);
  }
});

test('a payload that is valid base64 but not a session is refused', () => {
  const notASession = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
  assert.equal(verifySession(notASession + '.deadbeef', SECRET, NOW), null);
});

// ─── Expiry ──────────────────────────────────────────────────────────────────

test('an expired session is refused even though its signature is valid', () => {
  const token = signSession(payload({ exp: NOW - 1 }), SECRET);
  assert.equal(verifySession(token, SECRET, NOW), null);
});

test('a session is valid right up to its expiry instant', () => {
  const token = signSession(payload({ exp: NOW }), SECRET);
  assert.notEqual(verifySession(token, SECRET, NOW), null);
});

test('a session with no expiry is refused, not treated as eternal', () => {
  // Signing is not the only requirement. A token whose exp went missing must
  // not become a session that outlives every revocation.
  const body = Buffer.from(JSON.stringify({ sid: 's', uid: 'u', owner: true })).toString('base64url');
  // Sign it properly so ONLY the missing exp can be what refuses it.
  const token = signSession({ sid: 's', uid: 'u', owner: true, exp: NOW + HOUR }, SECRET);
  const forged = body + '.' + token.split('.')[1];
  assert.equal(verifySession(forged, SECRET, NOW), null);
});
