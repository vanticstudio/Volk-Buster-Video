// Handing the store app a working Plex connection, so no viewer configures one.
//
// The model this serves: the owner sets the store up once, and anyone they have
// shared a Plex library with signs in and sees THEIR OWN access. That last part
// is not a policy this code applies — it falls out of resolving the connection
// from the requester's own token, because Plex only returns what that account
// can reach. These tests pin the pieces that make it hold.
//
//   npm run test:plexconn

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickConnection, connectionBootstrapScript } from '../server/plex-connection.ts';

const conn = (over: Record<string, unknown> = {}) => ({
  uri: 'https://1-2-3-4.abc.plex.direct:32400',
  local: false,
  relay: false,
  protocol: 'https',
  address: '1.2.3.4',
  ...over,
} as never);

// ─── Which address the browser is told to use ───────────────────────────────

test('a remote HTTPS address wins', () => {
  // The store is served over HTTPS on a public domain, so a browser refuses to
  // fetch from plain HTTP at all — this is a hard requirement, not a preference.
  const chosen = pickConnection([
    conn({ uri: 'http://192.168.1.50:32400', protocol: 'http', local: true }),
    conn({ uri: 'https://remote.plex.direct:32400' }),
  ]);
  assert.equal(chosen, 'https://remote.plex.direct:32400');
});

test('a remote address beats a local one', () => {
  // A LAN URI only helps viewers on the same network, and the ones who are can
  // still reach the remote address. Preferring local would hang for everyone
  // else rather than failing cleanly.
  const chosen = pickConnection([
    conn({ uri: 'https://local.plex.direct:32400', local: true }),
    conn({ uri: 'https://remote.plex.direct:32400', local: false }),
  ]);
  assert.equal(chosen, 'https://remote.plex.direct:32400');
});

test('relay is a last resort, not a default', () => {
  // Plex rate-limits and bandwidth-caps relay. Picking it while a direct
  // address exists would throttle every viewer for no reason.
  const chosen = pickConnection([
    conn({ uri: 'https://relay.plex.direct:443', relay: true }),
    conn({ uri: 'https://direct.plex.direct:32400', relay: false }),
  ]);
  assert.equal(chosen, 'https://direct.plex.direct:32400');
});

test('relay is used when it is all there is', () => {
  const chosen = pickConnection([conn({ uri: 'https://relay.plex.direct:443', relay: true })]);
  assert.equal(chosen, 'https://relay.plex.direct:443');
});

test('no connections resolves to null rather than a broken URL', () => {
  // The caller treats null as "show the store's own setup terminal", which is a
  // worse experience than a stocked store and a far better one than a store
  // silently pointed at nothing.
  assert.equal(pickConnection([]), null);
  assert.equal(pickConnection(undefined as never), null);
});

// ─── What gets written into the page ────────────────────────────────────────

test('the bootstrap writes the keys the app reads at module-eval time', () => {
  const js = connectionBootstrapScript(
    { url: 'https://s.plex.direct:32400', token: 'per-server-token', machineId: 'm1', name: 'Home' },
    'plex-user-42',
  );
  // These names are legacy and no longer describe what they hold: on this
  // Plex-only fork the key called jellyfin_url holds a Plex address. Renaming
  // them would orphan existing installs, so the test pins the real names.
  for (const key of ['media_sources', 'provider_kind', 'jellyfin_url', 'jellyfin_token']) {
    assert.match(js, new RegExp(key), `${key} must be seeded`);
  }
  // media_sources is a JSON STRING nested inside the outer JSON, so its quotes
  // arrive escaped. Matching the escaped form is the point, not an accident.
  assert.match(js, /\\"kind\\":\\"plex\\"/);
  assert.match(js, /https:\/\/s\.plex\.direct:32400/);
});

test('the bootstrap cannot break the page it is injected into', () => {
  // It runs inline, ahead of the app's own module. An exception here would stop
  // the document before the store ever loaded, so it has to be self-contained
  // and total: wrapped, and safe when localStorage throws (private mode).
  const js = connectionBootstrapScript(
    { url: 'https://s.plex.direct:32400', token: 't', machineId: 'm', name: 'n' }, 'u');
  assert.match(js, /^\(function\(\)\{try\{/, 'must be an IIFE with a try');
  assert.match(js, /catch\(e\)/, 'must swallow a localStorage failure');
  assert.doesNotMatch(js, /<\/script>/i, 'must not be able to close its own script tag');
});

test('a server name with quotes cannot break out of the injected JS', () => {
  // Server names are user-controlled. JSON.stringify is what keeps a hostile
  // one from becoming script, so this asserts the escaping rather than trusting
  // it — the payload is written straight into an inline <script>.
  const js = connectionBootstrapScript(
    { url: 'https://s.plex.direct:32400', token: 't', machineId: 'm', name: '</script><script>alert(1)' },
    'u',
  );
  assert.doesNotMatch(js, /<\/script>/i);
  assert.doesNotMatch(js, /<script>alert/i);
});

// ─── Viewer mode ────────────────────────────────────────────────────────────

const CONN = { url: 'https://s.plex.direct:32400', token: 'tok', machineId: 'm1', name: 'Home' };

test('the bootstrap tells the store a front door is in front of it', () => {
  // The store cannot otherwise know. Without this flag the counter CRT offers a
  // public viewer SUSPEND SYSTEM (sleeps the owner's NAS), MANAGER OVERRIDE and
  // CHANGE SERVER — on a port published through a Cloudflare tunnel.
  const js = connectionBootstrapScript(CONN, 'user-1');
  assert.match(js, /bb_viewer_only/);
  assert.match(js, /"bb_viewer_only":"1"/);
});

test('policy cannot shadow the viewer flag', () => {
  // policyKeys spreads last so a library key can never be masked by a
  // connection key — which also means a malformed policy could unset this one.
  // It cannot: policy only ever emits bb_carrylib_* and bb_games_enabled.
  const js = connectionBootstrapScript(CONN, 'user-1', { bb_games_enabled: '0' });
  assert.match(js, /"bb_viewer_only":"1"/);
});
