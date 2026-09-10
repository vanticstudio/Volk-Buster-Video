// First-run provisioning: the secrets nobody should ever have to type.
//
// The first version of this service made an operator paste SESSION_SECRET and
// TOKEN_ENCRYPTION_KEY into a compose file. These tests pin the properties that
// replaced that, and the one that makes it safe to regenerate nothing: the file
// must be created once, kept, and never silently replaced — a new key orphans
// every stored Plex token, so quietly making one is worse than refusing.
//
//   npm run test:bootstrap

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInstance, saveInstance, isConfigured } from '../server/bootstrap.ts';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'vb-bootstrap-'));
}

test('first boot generates real secrets with nothing configured', () => {
  const dir = freshDir();
  const inst = loadInstance(join(dir, 'store.db'));

  // 32 random bytes as hex. Long enough that guessing is not a strategy, and
  // generated rather than typed so it cannot be a passphrase somebody reused.
  assert.equal(inst.sessionSecret.length, 64);
  assert.equal(inst.tokenKey.length, 64);
  assert.match(inst.sessionSecret, /^[0-9a-f]+$/);
  assert.notEqual(inst.sessionSecret, inst.tokenKey, 'signing and encryption keys must differ');
});

test('two installs never share secrets', () => {
  const a = loadInstance(join(freshDir(), 'store.db'));
  const b = loadInstance(join(freshDir(), 'store.db'));
  assert.notEqual(a.sessionSecret, b.sessionSecret);
  assert.notEqual(a.tokenKey, b.tokenKey);
  assert.notEqual(a.setupToken, b.setupToken);
  assert.notEqual(a.plexClientId, b.plexClientId);
});

test('secrets survive a restart', () => {
  // The whole point of persisting them: a container restart must not log
  // everybody out or orphan the encrypted tokens in the database.
  const dir = freshDir();
  const first = loadInstance(join(dir, 'store.db'));
  const second = loadInstance(join(dir, 'store.db'));
  assert.equal(second.sessionSecret, first.sessionSecret);
  assert.equal(second.tokenKey, first.tokenKey);
  assert.equal(second.plexClientId, first.plexClientId);
});

test('the instance file is not world-readable', () => {
  // It holds the key that decrypts every viewer's Plex token. On a NAS, whose
  // volumes are routinely world-readable by design, the mode bits are the only
  // thing protecting it.
  const dir = freshDir();
  loadInstance(join(dir, 'store.db'));
  const mode = statSync(join(dir, 'instance.json')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a corrupt instance file refuses rather than regenerating', () => {
  // The dangerous alternative is silently minting a new key: every stored token
  // becomes undecryptable and everyone is logged out, with no explanation and
  // no way back. Failing loudly keeps a recoverable file problem recoverable.
  const dir = freshDir();
  writeFileSync(join(dir, 'instance.json'), '{"nonsense":true}');
  assert.throws(() => loadInstance(join(dir, 'store.db')), /missing sessionSecret/);
});

test('a store is not configured until a Plex server is chosen', () => {
  const dir = freshDir();
  const inst = loadInstance(join(dir, 'store.db'));
  assert.equal(isConfigured(inst), false, 'a fresh install gates on nothing');
  assert.equal(inst.plexMachineId, null);

  inst.plexMachineId = 'abc123machine';
  inst.setupToken = null;
  saveInstance(join(dir, 'store.db'), inst);

  const reloaded = loadInstance(join(dir, 'store.db'));
  assert.equal(isConfigured(reloaded), true);
  assert.equal(reloaded.plexMachineId, 'abc123machine');
});

test('the setup code is cleared once setup completes', () => {
  // It is the one credential that authorises changing what the store IS, so it
  // must not outlive the moment it was needed.
  const dir = freshDir();
  const inst = loadInstance(join(dir, 'store.db'));
  const original = inst.setupToken;
  assert.ok(original, 'a fresh install has a setup code');

  inst.plexMachineId = 'abc123machine';
  inst.setupToken = null;
  saveInstance(join(dir, 'store.db'), inst);

  assert.equal(loadInstance(join(dir, 'store.db')).setupToken, null);
  // And gone from the file, not merely from the parsed object. Checked against
  // the ORIGINAL value rather than by pattern: the secrets in the same file are
  // hex too, so a shape-based check would match them and always pass.
  const onDisk = readFileSync(join(dir, 'instance.json'), 'utf8');
  assert.doesNotMatch(onDisk, new RegExp(original!));
  assert.match(onDisk, /"setupToken": null/);
});
