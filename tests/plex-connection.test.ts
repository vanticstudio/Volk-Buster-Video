// Handing the store app a working Plex connection, so no viewer configures one.
//
// The model this serves: the owner sets the store up once, and anyone they have
// shared a Plex library with signs in and sees THEIR OWN access. That last part
// is not a policy this code applies — it falls out of resolving the connection
// from the requester's own token, because Plex only returns what that account
// can reach. These tests pin the pieces that make it hold — and the one rule
// the IP leak taught: the browser is told `/plex`, never an address.
//
//   npm run test:plexconn

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUpstream, connectionBootstrapScript, type StoreConnection } from '../server/plex-connection.ts';

const conn = (over: Record<string, unknown> = {}) => ({
  uri: 'https://1-2-3-4.abc.plex.direct:32400',
  local: false,
  relay: false,
  protocol: 'https',
  address: '1.2.3.4',
  ...over,
} as never);

// ─── Which address the FRONT DOOR proxies to ─────────────────────────────────

test('a LAN address wins — the proxy shares the server network', () => {
  // From a browser a LAN URI was useless across town; from the front door it
  // is the fastest path and avoids NAT hairpin entirely.
  const chosen = pickUpstream([
    conn({ uri: 'http://192.168.1.50:32400', protocol: 'http', local: true }),
    conn({ uri: 'https://remote.plex.direct:32400' }),
  ]);
  assert.equal(chosen?.uri, 'http://192.168.1.50:32400');
});

test('remote HTTPS beats remote plain HTTP', () => {
  // No browser is involved any more, so plain HTTP is no longer forbidden —
  // but Plex's own certificate is still the better default when LAN is gone.
  const chosen = pickUpstream([
    conn({ uri: 'http://203.0.113.7:32400', protocol: 'http' }),
    conn({ uri: 'https://remote.plex.direct:32400' }),
  ]);
  assert.equal(chosen?.uri, 'https://remote.plex.direct:32400');
});

test('plain HTTP is used before relay', () => {
  const chosen = pickUpstream([
    conn({ uri: 'https://relay.plex.direct:443', relay: true }),
    conn({ uri: 'http://203.0.113.7:32400', protocol: 'http' }),
  ]);
  assert.equal(chosen?.uri, 'http://203.0.113.7:32400');
});

test('relay is a last resort, not a default', () => {
  // Plex rate-limits and bandwidth-caps relay. Picking it while a direct
  // address exists would throttle every viewer for no reason.
  const chosen = pickUpstream([
    conn({ uri: 'https://relay.plex.direct:443', relay: true }),
    conn({ uri: 'https://direct.plex.direct:32400', relay: false }),
  ]);
  assert.equal(chosen?.uri, 'https://direct.plex.direct:32400');
});

test('relay is used when it is all there is', () => {
  const chosen = pickUpstream([conn({ uri: 'https://relay.plex.direct:443', relay: true })]);
  assert.equal(chosen?.uri, 'https://relay.plex.direct:443');
});

test('no usable connections resolves to null rather than a broken URL', () => {
  // The caller treats null as "show the store's own setup terminal", which is
  // a worse experience than a stocked store and a far better one than a store
  // silently pointed at nothing.
  assert.equal(pickUpstream([]), null);
  assert.equal(pickUpstream(undefined as never), null);
  assert.equal(pickUpstream([conn({ uri: 'not a url' })]), null);
});

test('the rewrite set collects EVERY advertised origin, not just the pick', () => {
  // A playlist may name any address the server advertises, and the rewrite
  // that misses one is the rewrite that leaks.
  const chosen = pickUpstream([
    conn({ uri: 'http://192.168.1.50:32400', protocol: 'http', local: true }),
    conn({ uri: 'https://1-2-3-4.abc.plex.direct:32400' }),
    conn({ uri: 'https://relay.plex.direct:443', relay: true }),
  ]);
  assert.deepEqual(chosen?.origins, [
    'http://192.168.1.50:32400',
    'https://1-2-3-4.abc.plex.direct:32400',
    // Both spellings of the default port: a playlist may quote either.
    'https://relay.plex.direct',
    'https://relay.plex.direct:443',
  ]);
});

test('origins are deduplicated and malformed URIs skipped', () => {
  const chosen = pickUpstream([
    conn({ uri: 'https://1-2-3-4.abc.plex.direct:32400', local: true }),
    conn({ uri: 'https://1-2-3-4.abc.plex.direct:32400' }),
    conn({ uri: 'garbage' }),
  ]);
  assert.deepEqual(chosen?.origins, ['https://1-2-3-4.abc.plex.direct:32400']);
});

// ─── What gets written into the page ────────────────────────────────────────

const CONN: StoreConnection = {
  url: '/plex',
  upstream: 'https://115-70-96-154.leaky.plex.direct:32400',
  origins: ['https://115-70-96-154.leaky.plex.direct:32400', 'http://192.168.1.50:32400'],
  token: 'per-server-token',
  machineId: 'm1',
  name: 'Home',
};

test('the bootstrap writes the keys the app reads at module-eval time', () => {
  const js = connectionBootstrapScript(CONN, 'plex-user-42');
  // These names are legacy and no longer describe what they hold: on this
  // Plex-only fork the key called jellyfin_url holds the front door's own
  // proxy path. Renaming them would orphan existing installs, so the test
  // pins the real names.
  for (const key of ['media_sources', 'provider_kind', 'jellyfin_url', 'jellyfin_token']) {
    assert.match(js, new RegExp(key), `${key} must be seeded`);
  }
  // media_sources is a JSON STRING nested inside the outer JSON, so its quotes
  // arrive escaped. Matching the escaped form is the point, not an accident.
  assert.match(js, /\\"kind\\":\\"plex\\"/);
  assert.match(js, /\\"url\\":\\"\/plex\\"/, 'the browser is pointed at the proxy base');
});

test('the browser is never told where the Plex server actually lives', () => {
  // The address encodes the operator's public IP. It sits server-side on the
  // connection object; the page must not carry it in any form.
  const js = connectionBootstrapScript(CONN, 'u');
  assert.doesNotMatch(js, /plex\.direct|115-70-96-154|192\.168\.1\.50/);
});

test('the bootstrap cannot break the page it is injected into', () => {
  // It runs inline, ahead of the app's own module. An exception here would stop
  // the document before the store ever loaded, so it has to be self-contained
  // and total: wrapped, and safe when localStorage throws (private mode).
  const js = connectionBootstrapScript(CONN, 'u');
  assert.match(js, /^\(function\(\)\{try\{/, 'must be an IIFE with a try');
  assert.match(js, /catch\(e\)/, 'must swallow a localStorage failure');
  assert.doesNotMatch(js, /<\/script>/i, 'must not be able to close its own script tag');
});

test('a server name with quotes cannot break out of the injected JS', () => {
  // Server names are user-controlled. JSON.stringify is what keeps a hostile
  // one from becoming script, so this asserts the escaping rather than
  // trusting it — the payload is written straight into an inline <script>.
  const js = connectionBootstrapScript(
    { ...CONN, name: '</script><script>alert(1)' },
    'u',
  );
  assert.doesNotMatch(js, /<\/script>/i);
  assert.doesNotMatch(js, /<script>alert/i);
});

// ─── Viewer mode ────────────────────────────────────────────────────────────

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
