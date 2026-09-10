// What vite serves in PRODUCTION.
//
// `npm run serve` — vite preview — is what the container runs, and the front
// door reverse-proxies it to any authenticated viewer. So every middleware
// registered with `configurePreviewServer` is reachable by everyone the owner
// let in, which is a different threat model from the one upstream designed for:
// a single household on a trusted LAN.
//
// Three of upstream's endpoints are genuinely dangerous under that model and
// were moved to dev-only. This file is the tripwire that keeps them there,
// because re-adding a `configurePreviewServer` hook is a one-line change that
// looks completely innocuous in a diff.
//
//   npm run test:preview

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONFIG = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

/**
 * The block of a named plugin's returned object, from its `name:` to the end of
 * that object literal. Crude, but it is reading a file rather than importing it
 * — vite.config.ts pulls in node built-ins and a top-level await that a plain
 * test process should not be executing.
 */
function pluginBlock(name: string): string {
  const at = CONFIG.indexOf(`name: "${name}"`);
  assert.notEqual(at, -1, `plugin "${name}" not found — did it get renamed?`);
  const end = CONFIG.indexOf('\n  };', at);
  assert.notEqual(end, -1, `could not find the end of "${name}"`);
  return CONFIG.slice(at, end);
}

test('the file-writing feedback endpoint is dev-only', () => {
  // /__feedback writes a screenshot and a note to disk. In the container that
  // is an authenticated viewer writing files to the owner's NAS.
  assert.doesNotMatch(
    pluginBlock('feedback-pin-endpoint'), /configurePreviewServer/,
    '/__feedback must not be registered on vite preview',
  );
});

test('the mpv spawner is dev-only', () => {
  // /__play starts a process on the host. It was always a feature for someone
  // sitting at the HTPC, and it means nothing to a remote viewer.
  assert.doesNotMatch(
    pluginBlock('mpv-player-endpoint'), /configurePreviewServer/,
    '/__play must not be registered on vite preview',
  );
});

test('the arbitrary-fetch integration proxy is dev-only', () => {
  // The most serious of the three: /dev-proxy fetches ANY url and attaches the
  // operator's credentials. Behind the front door that is a signed-in viewer
  // using the owner's NAS as an authenticated relay into their private network.
  assert.doesNotMatch(
    pluginBlock('integration-proxy'), /configurePreviewServer/,
    '/dev-proxy must not be registered on vite preview',
  );
});

test('the host guard IS still on preview', () => {
  // The inverse check. This one must stay: it is the DNS-rebinding protection,
  // and losing it would let a hostile page resolve its own name to the store's
  // address and read responses same-origin.
  assert.match(pluginBlock('halcyon-host-guard'), /configurePreviewServer/);
});

test('the operator-config endpoint IS still on preview', () => {
  // Read-only, and it serves addresses only — never an API key. It is how a
  // visitor arrives at a store the operator already configured, so removing it
  // would break that without improving anything.
  assert.match(pluginBlock('halcyon-operator-config'), /configurePreviewServer/);
});

test('no plugin outside the known set registers a preview middleware', () => {
  // Catches a NEW endpoint being added to production without anyone deciding
  // that it should be reachable by every viewer.
  const known = ['halcyon-host-guard', 'halcyon-operator-config'];
  const names = [...CONFIG.matchAll(/name: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  const onPreview = names.filter((n) => /configurePreviewServer/.test(pluginBlock(n)));
  assert.deepEqual(
    onPreview.sort(), known.sort(),
    `unexpected middleware on the production server: ${onPreview.filter((n) => !known.includes(n)).join(', ')}`,
  );
});
