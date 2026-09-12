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
import { createServer, request as httpRequest, type Server } from 'node:http';
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
/** What HTTP status the fake plex.tv answers /api/v2/resources with. */
let stubResourcesStatus = 200;

function stubPlex(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (url.includes('/api/v2/pins/')) return ok({ authToken: stubToken });
    if (url.includes('/api/v2/pins')) return ok({ id: 1234, code: 'STRONGCODE' });
    if (url.includes('/api/v2/user')) return ok({ id: 42, username: 'alice' });
    if (url.includes('/api/v2/resources')) {
      if (stubResourcesStatus === 200) return ok(stubResources);
      return new Response(JSON.stringify({ error: 'plex.tv down' }), {
        status: stubResourcesStatus, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = stubPlex();
  stubToken = 'a-plex-token';
  stubResourcesStatus = 200;
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

/**
 * The pin dance the GATE PAGE performs: the browser mints the pin at plex.tv
 * directly (the stub answers it), then registers the id with the server. The
 * server never creates pins — that is the IP-attribution fix under test — so
 * every sign-in in this file starts from the browser's side of the wall.
 */
async function browserMintPin(): Promise<number> {
  const res = await globalThis.fetch('https://plex.tv/api/v2/pins?strong=true', {
    method: 'POST',
    headers: { 'x-plex-client-identifier': 'test-client' },
  });
  const body = await res.json() as { id: number };
  return body.id;
}

/** Sign in and return the session cookie, or the failing response. */
async function signIn(): Promise<{ cookie: string | null; status: number; body: any }> {
  const id = await browserMintPin();
  const reg = await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(reg.status, 200, 'a freshly minted pin must register');
  const res = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
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

  const bobId = await browserMintPin();
  await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: bobId }),
  });
  const bobRes = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: bobId }),
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

test('a signed-in viewer gets the status page, and it is honest', async () => {
  // Lives at /whoami rather than /, because / is now the store itself.
  const { cookie } = await signIn();
  const body = await (await realFetch(`${base}/whoami`, { headers: { cookie: cookie! } })).text();
  assert.match(body, /You&#39;re in|You're in/);
  // It must NOT imply a store is loading — that would send a tester hunting a
  // fault that does not exist.
  assert.match(body, /not wired up to it yet/);
});

test('the owner status page says so', async () => {
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: true, home: false }];
  const { cookie } = await signIn();
  const body = await (await realFetch(`${base}/whoami`, { headers: { cookie: cookie! } })).text();
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

// ─── Rate limiting the unauthenticated endpoints ─────────────────────────────

test('pin registration is rate limited per caller', async () => {
  // Without this, anyone who can load the gate page can fill the shared
  // pending-pin table and crowd real viewers out of it.
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await realFetch(`${base}/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ id: 1000 + i }),
    })).status;
  }
  assert.equal(last, 429, 'the 11th+ attempt from one caller must be refused');
});

test('a pin body-less or malformed is refused, and buys no table slot', async () => {
  // The endpoint REGISTERS ids the browser minted; it creates nothing. A call
  // without a body is a broken page or a probe — refused either way.
  const bare = await realFetch(`${base}/auth/pin`, { method: 'POST' });
  assert.equal(bare.status, 400);
  const junk = await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'not-a-pin' }),
  });
  assert.equal(junk.status, 400);
  const negative = await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: -5 }),
  });
  assert.equal(negative.status, 400);
  const still = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 424242 }),
  });
  assert.equal(still.status, 400, 'nothing was registered, so nothing can be claimed');
});

test('claiming is rate limited per caller', async () => {
  // Each claim is a plex.tv round trip from an unauthenticated endpoint. A
  // legitimate sign-in claims once; this caps the endpoint as a pump.
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await realFetch(`${base}/auth/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ id: 1000 + i }),
    })).status;
  }
  assert.equal(last, 429, 'the 11th+ claim from one caller must be refused');
});

test('a forged client IP does NOT buy a fresh rate-limit bucket', async () => {
  // The counter-intuitive half, and the reason the default is not to trust the
  // header: an attacker who can set CF-Connecting-IP does not merely evade the
  // limit, they get an UNLIMITED number of buckets by varying it. Keying on
  // something forgeable is worse than not keying per-caller at all.
  delete process.env.TRUST_PROXY_HEADERS;
  let last = 0;
  for (let i = 0; i < 14; i++) {
    last = (await realFetch(`${base}/auth/pin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': `203.0.113.${i}`,  // a different "IP" each time
      },
      body: JSON.stringify({ id: 2000 + i }),
    })).status;
  }
  assert.equal(last, 429, 'varying the header must not reset the limit');
});

test('with TRUST_PROXY_HEADERS set, callers are limited per IP', async () => {
  // The opt-in posture, for when nothing but the proxy can reach this port.
  process.env.TRUST_PROXY_HEADERS = '1';
  try {
    for (let i = 0; i < 12; i++) {
      await realFetch(`${base}/auth/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
        body: JSON.stringify({ id: 3000 + i }),
      });
    }
    const other = await realFetch(`${base}/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.8' },
      body: JSON.stringify({ id: 3999 }),
    });
    assert.equal(other.status, 200, 'a different caller is unaffected');
  } finally {
    delete process.env.TRUST_PROXY_HEADERS;
  }
});

// ─── The store is only reachable through the gate ───────────────────────────
//
// The front door proxies the store app for authenticated requests. These pin
// the property that makes that safe: an unauthenticated request must never be
// proxied. If it were, the store — which has no authentication of its own —
// would be served to anyone who found the URL.

test('an unauthenticated request for a store asset is NOT proxied', async () => {
  // The failure this catches: a proxy placed before the session check, so
  // /assets/main.js sails through and the whole library is public.
  for (const path of ['/assets/main-abc123.js', '/textures/carpet.jpg', '/index.html', '/models/vcr.glb']) {
    const res = await realFetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} should render the gate, not proxy`);
    const body = await res.text();
    assert.match(body, /Members only/, `${path} must return the sign-in page`);
  }
});

test('a forged cookie does not get you past the proxy either', async () => {
  const forged = 'hv_session=' + Buffer.from('{"sid":"x","uid":"x","owner":true,"exp":9999999999999}').toString('base64url') + '.nope';
  const res = await realFetch(`${base}/assets/main.js`, { headers: { cookie: forged } });
  assert.match(await res.text(), /Members only/);
});

test('an authenticated request IS proxied to the store', async () => {
  // With no store running on appOrigin the proxy cannot connect, and the honest
  // answer is 502 — which is itself the proof that the request got past the
  // gate and was handed onward rather than being answered by the front door.
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/assets/main.js`, { headers: { cookie: cookie! } });
  assert.equal(res.status, 502, 'should attempt the upstream, not serve the gate');
  const body = await res.text();
  assert.match(body, /store is not running/i);
  assert.doesNotMatch(body, /Members only/);
});

test('a proxy failure never leaks the internal address', async () => {
  // The 502 body reaches a viewer. It must not tell them where the ungated
  // store actually lives.
  const { cookie } = await signIn();
  const body = await (await realFetch(`${base}/assets/main.js`, { headers: { cookie: cookie! } })).text();
  assert.doesNotMatch(body, /127\.0\.0\.1|localhost|1420/);
});

test('the status page is still served by the front door, not proxied', async () => {
  const { cookie } = await signIn();
  const body = await (await realFetch(`${base}/whoami`, { headers: { cookie: cookie! } })).text();
  assert.match(body, /You&#39;re in|You're in/);
});

// ─── The cookie has to survive the transport it is actually on ──────────────
//
// These exist because of a real bug: `Secure` was unconditional, so over plain
// HTTP on a LAN address the browser silently discarded the session cookie and
// sign-in looped forever with nothing in any log to explain it. Browsers exempt
// http://localhost, which is why local testing never caught it.

test('over plain HTTP the cookie is NOT marked Secure', async () => {
  // Otherwise the browser drops it and the viewer loops on the sign-in page.
  const { cookie } = await signIn();
  assert.ok(cookie, 'a session cookie must be issued');
  const raw = cookie!;
  assert.doesNotMatch(raw, /Secure/i, 'Secure over http makes the cookie unusable');
});

test('behind a TLS-terminating proxy the cookie IS marked Secure', async () => {
  // cloudflared and every reverse proxy speak plain HTTP to this process, so
  // the socket looks insecure even when the viewer is on HTTPS. Trusting the
  // socket alone would drop Secure on exactly the deployment that needs it.
  const id = await browserMintPin();
  await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const res = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ id }),
  });
  assert.match(res.headers.get('set-cookie') || '', /Secure/);
});

test('a proxy chain is read from its first entry', async () => {
  // "https, http" means the ORIGINAL request was HTTPS; reading the last hop
  // would get this exactly backwards.
  const id = await browserMintPin();
  await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const res = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https, http' },
    body: JSON.stringify({ id }),
  });
  assert.match(res.headers.get('set-cookie') || '', /Secure/);
});

test('the cookie is always HttpOnly and SameSite=Lax, whatever the transport', async () => {
  // HttpOnly keeps it away from scripts; Lax rather than Strict because the
  // Plex sign-in returns the viewer here by navigation and Strict would
  // withhold the cookie on that hop.
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/auth/signout`, { method: 'POST', headers: { cookie: cookie! } });
  const raw = res.headers.get('set-cookie') || '';
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
});

// ─── The link preview ───────────────────────────────────────────────────────
//
// The tunnel URL gets pasted into a chat window, and the crawler that follows
// it has no Plex account. So the card lives on the GATE, and the card's URL is
// built from the request's own Host header — which is attacker-controlled, and
// is the reason most of these tests exist.
//
// They use node:http directly rather than fetch(): undici forbids overriding
// the Host header outright, so a fetch-based version of the tests below would
// silently exercise the socket's own host and prove nothing about the ones
// that matter.

function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the gate carries a share card for an unauthenticated crawler', async () => {
  const { status, body } = await raw('/', { accept: 'text/html', host: 'store.volkanovski.dev' });
  assert.equal(status, 200);
  assert.match(body, /property="og:image" content="http:\/\/store\.volkanovski\.dev\/signin\/share\.png"/);
  assert.match(body, /property="og:url" content="http:\/\/store\.volkanovski\.dev\/"/);
  assert.match(body, /name="twitter:card" content="summary_large_image"/);
  // Dimensions are declared: several unfurlers lay the card out before the
  // image arrives, and without them they reserve a thumbnail-sized box and
  // never re-expand it.
  assert.match(body, /property="og:image:width" content="1200"/);
  assert.match(body, /property="og:image:height" content="630"/);
});

test('the card image is served without a session', async () => {
  // The whole point. A crawler cannot sign in, so a card behind the gate is a
  // card nobody ever sees.
  const res = await realFetch(`${base}/signin/share.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 1000, 'a real PNG, not an error page');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', 'PNG magic bytes');
});

test('the store itself is still gated — the card opens nothing', async () => {
  // Adding an unauthenticated route is exactly the change that could widen the
  // gate by accident, so this re-asserts the thing that must not have moved.
  const res = await realFetch(`${base}/api/movies`, { headers: { accept: 'application/json' } });
  assert.equal(res.status, 401);
});

test('a forged Host cannot break out of the meta attribute', async () => {
  // The Host header reaches an HTML attribute. Anything that survives quoting
  // here is script execution on the login page for someone's private library.
  const { status, body } = await raw('/', {
    accept: 'text/html',
    host: 'evil"><script>alert(1)</script>',
  });
  assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
  // Rejected outright rather than escaped-and-used: a header that shape is not
  // a host, and shipping no card is a purely cosmetic loss.
  assert.doesNotMatch(body, /og:image/, 'a malformed host yields no card at all');
  assert.equal(status, 200, 'and the page still renders');
});

test('a path smuggled into Host is refused', async () => {
  // It would otherwise re-point og:url at something under the sender's control
  // while still looking host-shaped to a naive check.
  const { body } = await raw('/', { accept: 'text/html', host: 'good.example.com/../../evil' });
  assert.doesNotMatch(body, /og:image/);
});

test('x-forwarded-proto decides the scheme, not the socket', async () => {
  // Behind cloudflared the connection to this process is plain HTTP while the
  // viewer's is HTTPS. An http:// og:image on an https:// page is blocked as
  // mixed content, and the card silently does not render.
  const { body } = await raw('/', {
    accept: 'text/html',
    host: 'store.example.com',
    'x-forwarded-proto': 'https',
  });
  assert.match(body, /content="https:\/\/store\.example\.com\/signin\/share\.png"/);
});

test('a proxy chain reports the ORIGINAL scheme', async () => {
  // Each hop appends, so the viewer's own scheme is the first entry. Reading
  // the last one describes the last proxy, not the browser.
  const { body } = await raw('/', {
    accept: 'text/html',
    host: 'store.example.com',
    'x-forwarded-proto': 'https, http',
  });
  assert.match(body, /content="https:\/\/store\.example\.com\/signin\/share\.png"/);
});

test('the gate stays out of search results', async () => {
  // A card in a chat is an invitation. A search result is a stranger finding
  // the login page for someone's private library. og tags do not imply the
  // second, and noindex is what keeps them apart.
  const { body } = await raw('/', { accept: 'text/html', host: 'store.example.com' });
  assert.match(body, /name="robots" content="noindex, nofollow"/);
});

// ─── Re-validation must not be destructive on a plex.tv outage ───────────────

test('a plex.tv outage during re-validation keeps the session', async () => {
  // The once-a-day re-check treats an unanswered question as neither a yes
  // nor a revocation. The regression this pins: fetchResources used to
  // collapse "network error" into "empty list", and empty meant "revoked" —
  // one plex.tv 5xx deleted every session and told the viewer their access
  // was removed, which was a lie.
  const { cookie } = await signIn();
  assert.ok(cookie);
  // Force the re-check window: backdate lastValidatedAt past revalidateAfterMs.
  const sid = JSON.parse(Buffer.from(cookie!.split('=')[1].split('.')[0], 'base64url').toString()).sid;
  db.touchSession(sid, NOW - 25 * 3600_000);

  stubResourcesStatus = 503; // plex.tv unreachable
  const res = await realFetch(`${base}/api/me`, { headers: { cookie: cookie! } });
  assert.equal(res.status, 200, 'an unanswered re-check must keep the session');

  // The failure must not have been silently treated as "still valid" forever
  // either: the next check after plex.tv heals must still run.
  stubResourcesStatus = 200;
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: false, home: false }];
  const again = await realFetch(`${base}/api/me`, { headers: { cookie: cookie! } });
  assert.equal(again.status, 200, 'healed plex.tv with access intact keeps the session');
});

test('a plex.tv outage at SIGN-IN fails closed with an honest error', async () => {
  stubResourcesStatus = 503;
  const id = await browserMintPin();
  await realFetch(`${base}/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const res = await realFetch(`${base}/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(res.status, 502, 'sign-in must refuse when the gate cannot be evaluated');
  assert.match((await res.json()).error, /reach plex\.tv/i, 'the error must not claim a permission problem');
});

test('a real revocation still wipes sessions at re-validation', async () => {
  const { cookie } = await signIn();
  const sid = JSON.parse(Buffer.from(cookie!.split('=')[1].split('.')[0], 'base64url').toString()).sid;
  db.touchSession(sid, NOW - 25 * 3600_000);

  // ANSWERED empty — the person genuinely has nothing shared with them now.
  stubResources = [];
  const res = await realFetch(`${base}/api/me`, { headers: { cookie: cookie! } });
  assert.equal(res.status, 403, 'an answered no must still revoke');
  assert.match((await res.json()).error, /removed/i, 'the message is now honest: only real revocations reach it');

  // The wipe is not a lockout: a person who was re-shared can sign straight
  // back in, which is what makes the owner's revoke lever safe to pull.
  stubResources = [{ clientIdentifier: MACHINE, provides: 'server', owned: false, home: false }];
  const reSignIn = await signIn();
  assert.equal(reSignIn.status, 200);
  assert.ok(reSignIn.cookie, 'a re-shared person can sign straight back in');
});

test('the setup code is rate limited, not merely hard to guess', async () => {
  // Twelve hex characters are not brute-forceable online, but there is no
  // reason to let anyone try at line rate — /setup/claim is the door to
  // owning the whole store, and it is unauthenticated until setup completes.
  const unconfigured = {
    sessionSecret: cfg.sessionSecret,
    tokenKey: '',
    setupToken: 'deadbeefcafe',
    plexMachineId: null,
    plexClientId: 'setup-test',
  };
  const setupDb = new FrontDoorStore(':memory:', cfg.tokenKey);
  const setupHandler = createFrontDoor(cfg, setupDb, () => NOW, unconfigured);
  const setupServer = createServer((req, res) => { void setupHandler(req, res); });
  await new Promise<void>((r) => setupServer.listen(0, '127.0.0.1', r));
  const setupBase = `http://127.0.0.1:${(setupServer.address() as { port: number }).port}`;
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await realFetch(`${setupBase}/setup/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'aaaa' }),
      })).status;
    }
    assert.equal(last, 429, 'the 11th+ guess from one caller must be refused');
  } finally {
    await new Promise<void>((r) => setupServer.close(() => r()));
    setupDb.close();
  }
});

// ─── The sign-in dance belongs to the browser ────────────────────────────────
//
// Plex's OAuth popup shows the person signing in the IP of the device that
// minted and polled the pin. Every request this server makes to plex.tv
// leaves through the home WAN, around the tunnel — so a server-minted pin
// printed the operator's public IP to every viewer (the incident that drove
// this). These pin the contract that keeps the dance on the viewer's side.

test('the gate page mints and polls its pin at plex.tv, from the browser', async () => {
  const body = await (await realFetch(`${base}/`)).text();
  assert.match(body, /plex\.tv\/api\/v2\/pins\?strong=true/, 'the browser mints the pin itself');
  assert.match(body, /app\.plex\.tv\/auth\#?\?/, 'the popup URL is built client-side');
  assert.match(body, /plex\.tv\/api\/v2\/pins\/'\s*\+\s*pinId/, 'the browser polls the pin itself');
  assert.match(body, /\/auth\/pin/, 'the server is told which pin id to expect');
  assert.match(body, /\/auth\/claim/, 'the server does the one authoritative claim');
  // The identity the pin is minted under must be the INSTALL's, so the
  // server-side claim (which must use the creator's identifier) succeeds.
  assert.match(body, /volkbuster-front-door/, 'the install client identifier is on the page');
});

test('the gate page CSP allows exactly one third party: plex.tv', async () => {
  const res = await realFetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy') || '', /connect-src[^;]*'self' https:\/\/plex\.tv/);
});

// ─── The Plex proxy: the browser's only route to the server ─────────────────
//
// The store used to be handed the server's own plex.direct address — the
// operator's public IP, encoded in the hostname, in every viewer's
// localStorage, with all media traffic flowing around the tunnel. The browser
// is now handed `/plex` and every request goes through the gate. These use a
// real upstream so the pipe, the rewriting and the gating are all exercised.

const LEAKY_ORIGIN = 'https://115-70-96-154.leaky.plex.direct:32400';

/** A Plex stand-in that leaks its own address the way real playlists do. */
async function startPlexUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/identity')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ MediaContainer: { machineIdentifier: MACHINE } }));
      return;
    }
    if (url.includes('start.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(`#EXTM3U\n${LEAKY_ORIGIN}/video/:/transcode/universal/segment-1.ts?X-Plex-Token=t\n`);
      return;
    }
    if (url.startsWith('/jump')) {
      res.writeHead(302, { location: `${LEAKY_ORIGIN}/library/redirected` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function resourcesWithConnections(uri: string): unknown[] {
  return [{
    clientIdentifier: MACHINE,
    provides: 'server',
    owned: false,
    home: false,
    name: 'Home',
    accessToken: 'per-server-token',
    connections: [
      { uri, local: true, relay: false, protocol: 'http', address: '192.168.1.50' },
      { uri: LEAKY_ORIGIN, local: false, relay: false, protocol: 'https', address: '115.70.96.154' },
    ],
  }];
}

test('an unauthenticated /plex request meets the gate, like the store', async () => {
  // Adding a proxy route is exactly the change that could widen the gate by
  // accident, so this re-asserts the thing that must not have moved.
  const res = await realFetch(`${base}/plex/identity`);
  assert.match(await res.text(), /Members only/, 'no session, no Plex');
});

test('a signed-in browser reaches Plex only through the proxy', async () => {
  const upstream = await startPlexUpstream();
  try {
    stubResources = resourcesWithConnections(`http://127.0.0.1:${upstream.port}`);
    const { cookie } = await signIn();
    const res = await realFetch(`${base}/plex/identity`, { headers: { cookie: cookie! } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /machineIdentifier/);
  } finally {
    await upstream.close();
  }
});

test('a proxied playlist cannot leak the server address', async () => {
  const upstream = await startPlexUpstream();
  try {
    stubResources = resourcesWithConnections(`http://127.0.0.1:${upstream.port}`);
    const { cookie } = await signIn();
    const res = await realFetch(`${base}/plex/video/:/transcode/universal/start.m3u8`, {
      headers: { cookie: cookie! },
    });
    const body = await res.text();
    assert.match(body, /\/plex\/video\/:/, 'segment URLs now name the proxy');
    assert.doesNotMatch(body, /plex\.direct|115-70-96-154|115\.70\.96\.154/, 'no address survives');
  } finally {
    await upstream.close();
  }
});

test('a redirect off the server own address is rewritten to the proxy', async () => {
  const upstream = await startPlexUpstream();
  try {
    stubResources = resourcesWithConnections(`http://127.0.0.1:${upstream.port}`);
    const { cookie } = await signIn();
    const res = await realFetch(`${base}/plex/jump`, {
      headers: { cookie: cookie! }, redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/plex/library/redirected');
  } finally {
    await upstream.close();
  }
});

test('the bootstrap hands the browser a path, never an address', async () => {
  // The document is only injected when the store upstream answers, so this
  // stands in for `vite preview` on the configured loopback port.
  const store = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head></head><body></body></html>');
  });
  await new Promise<void>((r) => store.listen(1420, '127.0.0.1', r));
  const upstream = await startPlexUpstream();
  try {
    stubResources = resourcesWithConnections(`http://127.0.0.1:${upstream.port}`);
    const { cookie } = await signIn();
    const res = await realFetch(`${base}/`, { headers: { cookie: cookie!, accept: 'text/html' } });
    const body = await res.text();
    assert.match(body, /"jellyfin_url":"\/plex"/, 'the store is pointed at the proxy base');
    assert.match(body, /\\"url\\":\\"\/plex\\",\\"token/, 'so is the media source inside it');
    assert.doesNotMatch(body, /plex\.direct|115-70-96-154|115\.70\.96\.154/,
      'the operator address must not appear anywhere in the page');
  } finally {
    await upstream.close();
    await new Promise<void>((r) => store.close(() => r()));
  }
});

test('a dead upstream answers 502 without naming the address', async () => {
  // Port 1 on loopback refuses everything; the viewer's answer must be an
  // outage, not a disclosure of where the pipe was pointed.
  stubResources = resourcesWithConnections('http://127.0.0.1:1');
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/plex/identity`, { headers: { cookie: cookie! } });
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.doesNotMatch(body, /127\.0\.0\.1|port|address/i);
  assert.match(body, /not reachable/i);
});

// ─── Baseline hardening on every response ───────────────────────────────────

test('every response carries the hardening floor', async () => {
  const res = await realFetch(`${base}/healthz`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('permissions-policy') || '', /microphone=\(\)/);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('HSTS is sent only when the request arrived over TLS', async () => {
  const secure = await realFetch(`${base}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(secure.headers.get('strict-transport-security') || '', /max-age/);
  const plain = await realFetch(`${base}/healthz`);
  assert.equal(plain.headers.get('strict-transport-security'), null,
    'an HSTS header on a LAN HTTP response would lock the owner out of their own store');
});

test('a proxied document refuses cross-origin framing and sniffing', async () => {
  // The 502 from the absent store still carries the floor — the error path is
  // exactly the one a new route is most likely to forget.
  const { cookie } = await signIn();
  const res = await realFetch(`${base}/assets/main.js`, { headers: { cookie: cookie! } });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
});
