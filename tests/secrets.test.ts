// Encryption at rest for viewers' Plex tokens.
//
// The database holds live Plex credentials for everyone the owner shared a
// library with, so "someone got a copy of store.db" must not equal "someone got
// several people's Plex accounts". These tests pin that, and pin the two ways
// a well-meaning change could quietly remove the protection: a short key being
// accepted, and a tampered ciphertext decrypting to something.
//
//   npm run test:secrets

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, encryptToken, decryptToken } from '../server/secrets.ts';

const KEY = deriveKey('a-perfectly-adequate-test-key-32chars');
const TOKEN = 'xxPlexToken-abc123';

test('a token survives a round trip', () => {
  assert.equal(decryptToken(encryptToken(TOKEN, KEY), KEY), TOKEN);
});

test('the plaintext never appears in the ciphertext', () => {
  // The point of the exercise. A stolen database file must not be grep-able.
  const sealed = encryptToken(TOKEN, KEY);
  assert.doesNotMatch(sealed, /PlexToken/);
  assert.doesNotMatch(sealed, /abc123/);
});

test('encrypting the same token twice gives different ciphertexts', () => {
  // A fresh IV per call. Without it, identical tokens produce identical rows —
  // which leaks that two viewers share a token, and with GCM specifically,
  // reusing an IV under one key breaks the cipher outright.
  assert.notEqual(encryptToken(TOKEN, KEY), encryptToken(TOKEN, KEY));
});

test('a different key cannot read it', () => {
  const other = deriveKey('a-completely-different-key-of-length');
  assert.equal(decryptToken(encryptToken(TOKEN, KEY), other), null);
});

test('a tampered ciphertext is refused, not silently corrupted', () => {
  // Authenticated encryption earning its keep: without the tag check, editing
  // the body would yield garbage that looks like a token, and the resulting
  // Plex auth failure would send someone debugging the wrong system entirely.
  const sealed = encryptToken(TOKEN, KEY);
  const [iv, tag, body] = sealed.split('.');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 0xff;
  assert.equal(decryptToken(`${iv}.${tag}.${flipped.toString('base64url')}`, KEY), null);
});

test('a tampered auth tag is refused', () => {
  const sealed = encryptToken(TOKEN, KEY);
  const [iv, tag, body] = sealed.split('.');
  const flipped = Buffer.from(tag, 'base64url');
  flipped[0] ^= 0xff;
  assert.equal(decryptToken(`${iv}.${flipped.toString('base64url')}.${body}`, KEY), null);
});

test('garbage decrypts to null rather than throwing', () => {
  // A corrupt row must be a sign-in prompt, not a crashed server.
  for (const junk of ['', '.', 'a.b', 'a.b.c', 'not base64!!', 'x'.repeat(200)]) {
    assert.equal(decryptToken(junk, KEY), null, `${JSON.stringify(junk)} must be refused`);
  }
});

test('a short encryption key is refused rather than stretched', () => {
  // The dangerous alternative is accepting anything and hashing it up to 32
  // bytes: the deployment would look encrypted, be trivially guessable, and
  // nobody would ever be told.
  assert.throws(() => deriveKey('short'), /at least 16 characters/);
  assert.throws(() => deriveKey(''), /at least 16 characters/);
});

test('the error explains how to generate a real key', () => {
  // An operator hitting this at 1am should not have to read the source.
  assert.throws(() => deriveKey('short'), /randomBytes/);
});
