// The front door end to end, over real HTTP, with plex.tv stubbed.
//
// The unit tests either side of this prove the gate decides correctly and that
// sessions cannot be forged. This file proves the SERVER actually asks them —
// the failure this catches is a handler that verifies a cookie and then forgets
// to check what it said, which no amount of testing the pure functions would
// reveal.
//
// plex.tv is replaced by swapping globalThis.fetch, so nothing here touches the
// network or needs a Plex account.
//
//   npm run test:frontdoorhttp

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createFrontDoor } from '../server/index.ts';
import { FrontDoorStore } from '../server/store.ts';
import { deriveKey } from '../server/secrets.ts';
import type { FrontDoorConfig } from '../server/config.ts';

const MACHINE = 'the-owners-server';
const NOW = 1_757_000_000_000;

const cfg: FrontDoorConfig = {
  port: 0,
  plexMachineId: MACHINE,
  sessionSecret: 'test-session-secret',
  tokenKey: deriveKey('front-door-http-test-key-1234'),
  databasePath: ':memory:',
  sessionTtlMs: 30 * 24 * 3600_000,
  revalidateAfterMs: 24 * 3600_000,
  distDir: './dist',
  appOrigin: 'http://127.0.0.1:1420',
};

let server: Server;
let base: string;
let db: FrontDoorStore;
let realFetch: typeof globalThis.fetch;

/** What our fake plex.tv will say about the caller's servers. */
let stubResources: unknown[] = [];
let stubToken: string | null = 'a-plex-token';

function stubPlex(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (url.includes('/api/v2/pins/')) return ok({ authToken: stubToken });
    if (url.includes('/api/v2/pins')) return ok({ id: 1234, code: 'STRONGCODE' });
    if (url.includes('/api/v2/user')) return ok({ id: 42, username: 'alice' });
    if (url.includes('/api/v2/resources')) return ok(stubResources);
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = stubPlex();
  stubToken = 'a-plex-token';
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: false, home: false }];

  db = new FrontDoorStore(':memory:', cfg.tokenKey);
  const handler = createFrontDoor(cfg, db, () => NOW);
  server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

/** Sign in and return the session cookie, or the failing response. */
async function signIn(): Promise<{ cookie: string | null; status: number; body: any }> {
  await realFetch(`${base}/auth/pin`, { method: 'POST' });
  const res = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1234 }),
  });
  const raw = res.headers.get('set-cookie');
  return {
    cookie: raw ? raw.split(';')[0] : null,
    status: res.status,
    body: await res.json().catch(() => null),
  };
}

// ─── The gate, over the wire ─────────────────────────────────────────────────

test('someone the owner shared with can sign in', async () => {
  const { status, cookie, body } = await signIn();
  assert.equal(status, 200);
  assert.ok(cookie, 'a session cookie must be set');
  assert.equal(body.username, 'alice');
  assert.equal(body.owner, false);
});

test('a valid Plex account with no access to this server is refused', async () => {
  // The attack this whole service exists to stop: a real Plex login from
  // someone who was never shared anything.
  stubResources = [{ clientIdentifier: 'their-own-server', provides: 'server', owned: true, home: false }];
  const { status, cookie } = await signIn();
  assert.equal(status, 403);
  assert.equal(cookie, null, 'a refused sign-in must not set a session');
});

test('the refusal tells the person what to do, without leaking anything', async () => {
  stubResources = [];
  const { body } = await signIn();
  assert.match(body.error, /share a library/i);
  assert.doesNotMatch(body.error, new RegExp(MACHINE), 'must not name the server id');
});

test('the owner is recognised as the owner', async () => {
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: true, home: false }];
  const { body } = await signIn();
  assert.equal(body.owner, true);
});

test('a pin nobody has authorised yet is pending, not a session', async () => {
  stubToken = null;
  const { status, cookie } = await signIn();
  assert.equal(status, 202);
  assert.equal(cookie, null);
});

test('claiming an unknown pin is refused', async () => {
  const res = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 999999 }),
  });
  assert.equal(res.status, 400);
});

// ─── Everything else requires a session ──────────────────────────────────────

test('the API is closed without a session', async () => {
  for (const path of ['/api/me', '/api/config']) {
    const res = await realFetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} must require a session`);
  }
});

test('a forged cookie does not open the API', async () => {
  // Not merely "some cookie is required" — a made-up one must fail the
  // signature check rather than being parsed and trusted.
  const res = await realFetch(`${base}/api/me`, {
    headers: { cookie: 'hv_session=' + Buffer.from('{"sid":"x","uid":"x","owner":true,"exp":9999999999999}').toString('base64url') + '.forged' },
  });
  assert.equal(res.status, 401);
});

test('health is open, because a probe has no cookie', async () => {
  const res = await realFetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

// ─── Owner-only enforcement, over the wire ───────────────────────────────────

test('a guest may set their own store settings', async () => {
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ key: 'bb_theme', value: 'bb-1990' }),
  });
  assert.equal(res.status, 200);

  const read = await realFetch(`${base}/api/config`, { headers: { cookie: cookie! } });
  assert.equal((await read.json()).bb_theme, 'bb-1990');
});

test('a guest CANNOT rebrand the store, even calling the API directly', async () => {
  // The point of enforcing server-side: hiding the row in the settings drawer
  // is a courtesy, this is the control.
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ key: 'bb_logo', value: '{"evil":true}' }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /owner-only/i);
});

test('the owner CAN rebrand the store', async () => {
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: true, home: false }];
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ key: 'bb_logo', value: '{"ok":true}' }),
  });
  assert.equal(res.status, 200);
});

test('nobody pushes a credential through the config endpoint', async () => {
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: true, home: false }];
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ key: 'plex_token', value: 'stolen' }),
  });
  assert.equal(res.status, 403);
});

// ─── Separation between viewers ──────────────────────────────────────────────

test('one viewer cannot read another viewer\'s settings', async () => {
  const alice = await signIn();
  await realFetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: alice.cookie! },
    body: JSON.stringify({ key: 'bb_theme', value: 'bb-1990' }),
  });

  // A second, different Plex account signs in.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/v2/pins/')) return ok({ authToken: 'bobs-token' });
    if (url.includes('/api/v2/pins')) return ok({ id: 5678, code: 'CODE2' });
    if (url.includes('/api/v2/user')) return ok({ id: 99, username: 'bob' });
    if (url.includes('/api/v2/resources')) return ok(stubResources);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;

  await realFetch(`${base}/auth/pin`, { method: 'POST' });
  const bobRes = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 5678 }),
  });
  const bobCookie = bobRes.headers.get('set-cookie')!.split(';')[0];

  const bobConfig = await (await realFetch(`${base}/api/config`, { headers: { cookie: bobCookie } })).json();
  assert.deepEqual(bobConfig, {}, "bob must not see alice's store");
});

// ─── Signing out ─────────────────────────────────────────────────────────────

test('signing out revokes the session server-side, not just in the browser', async () => {
  // Clearing the cookie is not enough — a copied cookie would still work. The
  // row has to go.
  const { cookie } = await signIn();
  await realFetch(`${base}/auth/signout`, { method: 'POST', headers: { cookie: cookie! } });
  const res = await realFetch(`${base}/api/me`, { headers: { cookie: cookie! } });
  assert.equal(res.status, 401);
});

// ─── The sign-in page ────────────────────────────────────────────────────────

test('a browser with no session gets the gate page, not a JSON error', async () => {
  const res = await realFetch(`${base}/`);
  assert.equal(res.status, 200, 'this IS the page for this request, not a failure to render one');
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const body = await res.text();
  assert.match(body, /Members only/);
  assert.match(body, /Sign in with Plex/);
});

test('the gate page never fetches a font from Google', async () => {
  // A project rule with a reason recorded in src/styles.css: a previous version
  // handed Google an IP, user-agent and referer on every boot of a 24/7 kiosk.
  const body = await (await realFetch(`${base}/`)).text();
  assert.doesNotMatch(body, /fonts\.googleapis|fonts\.gstatic|@import/);
  assert.match(body, /\/signin\/archivo-black\.ttf/, 'the face is self-hosted');
});

test('the gate page is not indexable and cannot be framed', async () => {
  const res = await realFetch(`${base}/`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(await res.text(), /noindex/);
});

test('the self-hosted font is served', async () => {
  const res = await realFetch(`${base}/signin/archivo-black.ttf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /font\/ttf/);
  assert.ok(Number(res.headers.get('content-length')) > 10_000, 'a real font file');
});

test('a signed-in viewer gets the landing page, and it is honest', async () => {
  const { cookie } = await signIn();
  const body = await (await realFetch(`${base}/`, { headers: { cookie: cookie! } })).text();
  assert.match(body, /You&#39;re in|You're in/);
  // It must NOT imply a store is loading — that would send a tester hunting a
  // fault that does not exist.
  assert.match(body, /not wired up to it yet/);
});

test('the owner landing page says so', async () => {
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: true, home: false }];
  const { cookie } = await signIn();
  const body = await (await realFetch(`${base}/`, { headers: { cookie: cookie! } })).text();
  assert.match(body, /owner, full admin/);
});

test('a signed-out browser is redirected back to the gate', async () => {
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/auth/signout`, {
    method: 'POST',
    headers: { cookie: cookie!, accept: 'text/html' },
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

// ─── Rate limiting the one public endpoint that calls out ────────────────────

test('pin creation is rate limited per caller', async () => {
  // Without this, anyone who can load the gate page can make this server hammer
  // plex.tv and exhaust the shared pending-pin table for real viewers.
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await realFetch(`${base}/auth/pin`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    })).status;
  }
  assert.equal(last, 429, 'the 11th+ attempt from one caller must be refused');
});

test('one caller being limited does not lock out everybody else', async () => {
  for (let i = 0; i < 12; i++) {
    await realFetch(`${base}/auth/pin`, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.7' } });
  }
  const other = await realFetch(`${base}/auth/pin`, {
    method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.8' },
  });
  assert.equal(other.status, 200, 'a different caller is unaffected');
});
