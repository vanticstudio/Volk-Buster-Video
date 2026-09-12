/**
 * The front door — the only process this deployment exposes to the internet.
 *
 * `cloudflared` points here and nowhere else. Vite preview and, in a later
 * phase, every rendering instance bind to loopback. That is the whole point of
 * the shape: upstream's dev/preview middleware (`/dev-proxy`, an arbitrary
 * fetch relay; `/__play`, which spawns mpv; `/__feedback`, which writes files)
 * ships live in `npm run serve`, which is what Docker and systemd actually run.
 * Rather than trying to gate those routes, this design makes them unreachable
 * — you cannot forget to protect a port you never published.
 *
 * WHAT IT DOES
 *   GET  /healthz              liveness, unauthenticated by design
 *   POST /auth/pin             register a pin the VIEWER'S BROWSER minted at
 *                              plex.tv (the popup must attribute the sign-in
 *                              to the viewer's own IP — a pin minted here
 *                              would publish the operator's home IP to every
 *                              viewer, which is the leak this fork fixed)
 *   POST /auth/claim           exchange an authorised pin for a session cookie
 *   POST /auth/signout         drop this session
 *   *    /plex/**              the viewer's own Plex server, proxied so the
 *                              browser only ever sees this origin
 *   GET  /api/me               who am I, and am I the owner
 *   GET  /api/config           this viewer's store settings
 *   PUT  /api/config           write one setting, owner rules enforced here
 *   *                          the store app, behind the gate
 *
 * Phase 1 of docs/architecture/2026-09-06-plex-only-streaming-fork.md. The
 * instance pool (Phase 2) attaches at `requireSession` — it is the thing that
 * turns a session into a rendering instance.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig, type FrontDoorConfig } from './config.ts';
import { FrontDoorStore } from './store.ts';
import { signSession, verifySession, type SessionPayload } from './sessions.ts';
import { grantsAccessTo, isOwnerOf } from './plex-gate.ts';
import { claimPin, fetchAccount, fetchResources, type PlexClientIdentity } from './plex-client.ts';
import { RateLimiter } from './rate-limit.ts';
import { assertWritable } from './owner-keys.ts';
import { signInPage, signedInPage } from './signin-page.ts';
import { proxyToApp } from './app-proxy.ts';
import { setupPage } from './setup-page.ts';
import { connectionForViewer, connectionBootstrapScript, type StoreConnection } from './plex-connection.ts';
import { proxyPlex, plexProxyTarget } from './plex-proxy.ts';
import { loadPolicy, policyKeys } from './admin-config.ts';
import { startAdminServer } from './admin.ts';
import { APP_VERSION } from './version.ts';
import { saveInstance, isConfigured, type InstanceSecrets } from './bootstrap.ts';

const COOKIE = 'hv_session';

const PIN_TTL_MS = 10 * 60_000;
const PIN_RATE_WINDOW_MS = 10 * 60_000;
const PIN_RATE_MAX = 10;
/**
 * `/auth/claim` is one plex.tv round trip per call, and it is unauthenticated.
 * A legitimate sign-in calls it once or twice — the browser polls plex.tv
 * itself and claims once at the end — so a small window is plenty, and the
 * tighter limit keeps a stranger from turning this endpoint into a plex.tv
 * traffic pump. Unknown pin ids are refused before any plex.tv call, so the
 * cheap hammering path is already closed; this bounds the expensive one.
 */
const CLAIM_RATE_WINDOW_MS = 10 * 60_000;
const CLAIM_RATE_MAX = 10;

/**
 * Who is calling, for rate-limiting purposes.
 *
 * `CF-Connecting-IP` is only trusted when TRUST_PROXY_HEADERS says a proxy is
 * genuinely in front, and the default is NOT to trust it.
 *
 * The reasoning runs the opposite way to the obvious one. An attacker who can
 * set that header freely does not merely evade the limit — they get an
 * unlimited number of distinct buckets by sending a different value each time,
 * which is strictly worse than having no per-caller limit at all. A limiter
 * keyed on something forgeable is an illusion of one.
 *
 * Falling back to the socket address behind a tunnel means every caller shares
 * one bucket, so the limit becomes global rather than per-IP. That is a real
 * cost — one noisy client can use up everyone's allowance — but it fails
 * closed and is honest about what it is, which a spoofable key is not.
 *
 * Set TRUST_PROXY_HEADERS=1 only when nothing but the proxy can reach this
 * port, which is exactly the case behind cloudflared with the service bound to
 * loopback or inside a container network.
 */
function callerKey(req: IncomingMessage): string {
  // Read per call rather than cached at module load, so a test can exercise
  // both postures in one process. The cost is one env lookup on an endpoint
  // that is already making a network request to plex.tv.
  if (process.env.TRUST_PROXY_HEADERS === '1') {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.split(',')[0].trim();
    const xff = req.headers['x-forwarded-for'];
    const first = Array.isArray(xff) ? xff[0] : xff;
    if (typeof first === 'string' && first) return first.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** The bundled display face, self-hosted — never fetched from Google. */
let fontCache: Buffer | null = null;
function archivoBlack(): Buffer | null {
  if (fontCache) return fontCache;
  try {
    fontCache = readFileSync(new URL('../src/assets/archivo-black.ttf', import.meta.url));
    return fontCache;
  } catch {
    // The page falls back to Arial Black. A missing font is a cosmetic
    // problem, never a reason to fail a sign-in.
    return null;
  }
}

/**
 * The social card, generated by tools/gen-share-image.mjs into public/ — which
 * is in the image (see .dockerignore's whitelist) and is also what Vite copies
 * into dist/, so one file serves both the front door and a directly-run store.
 */
let cardCache: Buffer | null = null;
function shareCard(): Buffer | null {
  if (cardCache) return cardCache;
  try {
    cardCache = readFileSync(new URL('../public/share/volkbuster-share.png', import.meta.url));
    return cardCache;
  } catch {
    // No card is a missing preview, never a failed sign-in.
    return null;
  }
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    // The page talks to itself and, on one deliberate exception, to plex.tv —
    // the viewer's browser mints and polls the OAuth pin directly so the
    // popup never names this deployment's address. Everything else is same-origin.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
      + "font-src 'self'; img-src 'self' data:; connect-src 'self' https://plex.tv; form-action 'self'; "
      + "base-uri 'none'; frame-ancestors 'none'",
    // The gate opens the plex.tv popup and nothing else; no cross-window
    // relationship is wanted, so none is permitted.
    'cross-origin-opener-policy': 'same-origin',
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // This is an API for our own page; nothing should frame it or sniff it.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Is this request actually running over TLS?
 *
 * `Secure` used to be unconditional here, on the reasoning that the only way in
 * was an HTTPS tunnel. That was wrong, and it produced an infinite sign-in
 * loop: over plain HTTP on a LAN address the browser SILENTLY DISCARDS a Secure
 * cookie, so authentication succeeded server-side, the cookie never survived,
 * and the next request arrived with no session — back to the sign-in page,
 * forever, with nothing in any log to say why.
 *
 * (http://localhost is exempt in browsers, which is why it never showed up in
 * local testing. http://192.168.x.x is not.)
 *
 * `x-forwarded-proto` first, because behind cloudflared or any reverse proxy
 * the connection to this process is plain HTTP even though the viewer's is
 * HTTPS — trusting the socket alone would drop Secure on exactly the deployment
 * that needs it most.
 */
function isSecureRequest(req: IncomingMessage): boolean {
  const header = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(header) ? header[0] : header;
  // A chain of proxies appends, so the ORIGINAL scheme is the first entry.
  if (typeof proto === 'string' && proto.length) {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/**
 * The public origin this request arrived at, or '' if it cannot be trusted.
 *
 * Needed for the link-preview card: og:image must be an ABSOLUTE URL (Twitter
 * and iMessage ignore a relative one), and this process cannot know its own
 * public name — behind cloudflared the tunnel terminates elsewhere and the
 * socket only ever sees 127.0.0.1.
 *
 * SO IT COMES FROM THE HOST HEADER, which is attacker-controlled, and that is
 * the whole reason for the allowlist below. A host is accepted only if it
 * looks like a hostname or an IP with an optional port — no slashes, no
 * spaces, no quotes, nothing that could carry a path or break out of the
 * attribute it lands in. A rejected host yields '' and the page simply ships
 * without a card, which is a cosmetic loss and never a broken page.
 *
 * The consequence of a forged Host is that someone who can already reach this
 * port makes their OWN preview point at their own hostname. There is nothing
 * to steal there: the image is public and the page it decorates is the login
 * screen. The escaping is what matters, and it is unconditional.
 */
const SAFE_HOST = /^[a-z0-9.-]{1,253}(:\d{1,5})?$|^\[[0-9a-f:]{2,45}\](:\d{1,5})?$/i;
function publicOrigin(req: IncomingMessage, hostnameLock = ''): string {
  const raw = req.headers.host;
  const host = Array.isArray(raw) ? raw[0] : raw;
  if (!host || !SAFE_HOST.test(host)) return '';
  // An operator who pins PUBLIC_HOSTNAME gets a card only for that name,
  // whatever port the Host header trails. The escaping above still applies
  // either way; this narrows which hosts are worth a card at all.
  const bare = host.toLowerCase().replace(/:\d+$/, '');
  if (hostnameLock && bare !== hostnameLock.toLowerCase()) return '';
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

/**
 * `SameSite=Lax` rather than Strict: the Plex sign-in sends the viewer to
 * app.plex.tv and back, and Strict would withhold the cookie on that return
 * navigation, so a freshly signed-in viewer would land looking signed out.
 */
function cookieAttrs(req: IncomingMessage): string {
  return `HttpOnly;${isSecureRequest(req) ? ' Secure;' : ''} SameSite=Lax; Path=/`;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeMs: number): void {
  res.setHeader('set-cookie',
    `${COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(req)}; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}

function clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('set-cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // A body limit is not optional on a public endpoint: without it, one
    // request can exhaust the process's memory.
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ─── The service ─────────────────────────────────────────────────────────────

/**
 * Baseline hardening applied to EVERY response this service sends — its own
 * pages, JSON, proxied store documents and proxied Plex bodies alike.
 *
 * `html()` and `json()` refine some of these with their own writeHead values;
 * setting them here first means the handlers can never forget one on a new
 * route, which is the failure mode that matters: an endpoint added next month
 * inherits the floor automatically.
 *
 * HSTS only over TLS as reported by the proxy chain (see isSecureRequest) —
 * over plain HTTP on a LAN address the header is meaningless, and a browser
 * that saw one there anyway would lock the owner out of their own store on
 * the port they test against.
 */
function applySecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // A CSP holding ONLY frame-ancestors: it does not constrain the page's own
  // resources (the store's needs are vite's business), so it cannot break
  // anything, while still refusing to let another origin frame this one.
  res.setHeader('content-security-policy', "frame-ancestors 'self'");
  // Nothing on this origin is meant to be embedded from anywhere else — the
  // proxied bodies carry per-viewer tokens.
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (isSecureRequest(req)) {
    res.setHeader('strict-transport-security', 'max-age=15552000');
  }
}

export function createFrontDoor(
  cfg: FrontDoorConfig,
  db: FrontDoorStore,
  now: () => number = Date.now,
  instance?: InstanceSecrets,
) {
  /**
   * First-run state. Held in a closure so a test can drive setup without
   * touching disk, and mutated in place when setup completes so the running
   * process starts gating immediately rather than needing a restart.
   */
  const inst: InstanceSecrets = instance ?? {
    sessionSecret: cfg.sessionSecret,
    tokenKey: '',
    setupToken: null,
    plexMachineId: cfg.plexMachineId || null,
    plexClientId: process.env.PLEX_CLIENT_ID || 'volkbuster-front-door',
  };
  /**
   * Resolved Plex connections, per session.
   *
   * Resolving one costs a plex.tv round trip, and it is needed on every
   * document load. Without a cache a viewer walking around the store would
   * re-query plex.tv on each navigation, which is slow for them and rude to
   * Plex. Short-lived so a server address that changes — a new LAN IP, relay
   * coming or going — is picked up without a sign-out.
   */
  const connCache = new Map<string, { conn: StoreConnection | null; at: number }>();
  const CONN_TTL_MS = 10 * 60_000;

  async function connectionFor(sid: string, viewerToken: string): Promise<StoreConnection | null> {
    const hit = connCache.get(sid);
    if (hit && now() - hit.at < CONN_TTL_MS) return hit.conn;
    const conn = await connectionForViewer(viewerToken, cfg.plexMachineId, identity);
    connCache.set(sid, { conn, at: now() });
    return conn;
  }

  /** Cleared once a setup code is accepted, so the code is single-use. */
  let setupClaimed = false;
  /** The Plex token of whoever is completing setup, held only until they pick. */
  let setupToken: string | null = null;
  /**
   * Sign-in state belongs to THIS front door, not to the module.
   *
   * Module-level maps would be shared by every instance in a process — which
   * makes two servers silently share a rate-limit budget and a pin table, and
   * makes them untestable in isolation (the second test in a file inherits the
   * first one's exhausted limiter). Per-instance is both the correct scope and
   * the testable one.
   *
   * In memory rather than in SQLite on purpose: a pin is worthless the moment
   * it is claimed, and a restart mid-sign-in just means signing in again.
   */
  const pendingPins = new Map<number, { createdAt: number }>();

  /**
   * Per-caller rate limits on the two unauthenticated endpoints that write
   * shared state or reach out to plex.tv on a stranger's say-so.
   *
   * `/auth/pin` REGISTERS a pin the viewer's browser minted (it no longer
   * creates one — that is the IP-leak fix). Without the limit, anyone who can
   * load the gate page can fill the shared pending-pin table and crowd out
   * real viewers. `/auth/claim` costs one plex.tv round trip per call, so it
   * is limited too — tighter than the pin window, because a legitimate
   * sign-in claims once.
   *
   * Keying is `callerKey`, whose trust posture is documented above: behind
   * cloudflared with TRUST_PROXY_HEADERS unset, every caller shares one
   * bucket — global rather than per-IP, and honest about it.
   */
  const pinLimiter = new RateLimiter(PIN_RATE_WINDOW_MS, PIN_RATE_MAX);
  const claimLimiter = new RateLimiter(CLAIM_RATE_WINDOW_MS, CLAIM_RATE_MAX);
  /**
   * First run only, and the most sensitive unauthenticated surface there is:
   * `/setup/claim` is the door to owning the whole store, and `/setup/claim-pin`
   * costs a plex.tv round trip. Twelve hex characters are not brute-forceable
   * online in any practical sense, but there is no reason to let anyone try at
   * line rate either.
   */
  const setupLimiter = new RateLimiter(10 * 60_000, 10);

  /** Drop pins nobody will ever claim again, keeping the map bounded. */
  function sweepPins(at: number): void {
    for (const [id, p] of pendingPins) {
      if (at - p.createdAt > PIN_TTL_MS) pendingPins.delete(id);
    }
  }

  const identity: PlexClientIdentity = {
    // Stable per install. See plex-client.ts — Plex keys session eviction off
    // this, so it is read from config and only generated once.
    clientId: process.env.PLEX_CLIENT_ID || inst.plexClientId,
    product: process.env.PLEX_PRODUCT || 'VolkBuster Video',
    version: APP_VERSION,
    device: 'VolkBuster Front Door',
    platform: 'Node',
  };

  /**
   * Resolve the caller's session, or null.
   *
   * Two layers, and both are needed. The cookie proves the session was minted
   * here and has not expired. The database lookup proves it has not since been
   * revoked — a signature alone cannot express "the owner unshared this person
   * ten minutes ago", because the token was already signed before that
   * happened.
   */
  function currentSession(req: IncomingMessage): { payload: SessionPayload; token: string } | null {
    const raw = readCookie(req, COOKIE);
    if (!raw) return null;
    const payload = verifySession(raw, cfg.sessionSecret, now());
    if (!payload) return null;
    const stored = db.getSession(payload.sid);
    if (!stored) return null;
    return { payload, token: stored.token };
  }

  /**
   * Re-check a live session against Plex sharing, at most once per
   * `revalidateAfterMs`.
   *
   * Without this, revocation only takes effect when the session expires — up to
   * a month later. With it, unsharing a library removes access within a day,
   * and the check costs one plex.tv call per viewer per day.
   */
  async function revalidate(sid: string, uid: string, token: string): Promise<boolean> {
    const stored = db.getSession(sid);
    if (!stored) return false;
    if (now() - stored.lastValidatedAt < cfg.revalidateAfterMs) return true;

    const resources = await fetchResources(token, identity);
    // plex.tv unreachable: the re-check cannot answer whether sharing changed,
    // and an unanswered question is NOT a revocation. Keep the session — it
    // re-checks on a later request. (Sign-in still fails closed below; only
    // the destructive wipe needs this guard.)
    if (resources === null) {
      console.warn(`[front-door] revalidate: could not reach plex.tv for ${uid} — keeping the session`);
      return true;
    }
    if (!grantsAccessTo(resources, cfg.plexMachineId)) {
      // Every session this person holds goes, not just the one that happened to
      // make this request — otherwise their other tab keeps working.
      db.deleteSessionsForUser(uid);
      return false;
    }
    db.touchSession(sid, now());
    return true;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    applySecurityHeaders(req, res);

    try {
      // ── Unauthenticated ────────────────────────────────────────────────────

      if (path === '/healthz') {
        return json(res, 200, { ok: true });
      }

      // Served unauthenticated because the sign-in page itself needs it, and a
      // display face is not a secret.
      if (path === '/signin/archivo-black.ttf') {
        const font = archivoBlack();
        if (!font) return json(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'content-type': 'font/ttf',
          'content-length': font.length,
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(font);
        return;
      }

      // The link-preview card, for crawlers that have no Plex account and
      // never will (see shareTags in signin-page.ts). Cached hard: unfurlers
      // refetch it far more often than it changes, and it is a fixed asset.
      if (path === '/signin/share.png') {
        const card = shareCard();
        if (!card) return json(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': card.length,
          'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff',
        });
        res.end(card);
        return;
      }

      // ── First run ──────────────────────────────────────────────────────
      //
      // Until a Plex server is chosen there is nothing to check anyone against,
      // so these are open by necessity. The setup CODE is what stands in for a
      // session: it is printed to the container log, so producing it proves
      // control of the host, which is exactly the claim being made.
      if (!isConfigured(inst)) {
        if (path === '/setup' || (path === '/' && req.method === 'GET')) {
          return html(res, 200, setupPage(identity));
        }

        if (path === '/setup/claim' && req.method === 'POST') {
          if (setupLimiter.limited(callerKey(req), now())) {
            return json(res, 429, { error: 'too many attempts, try again shortly' });
          }
          const body = await readJsonBody(req) as { token?: string };
          const given = String(body?.token ?? '').trim().toLowerCase();
          const expected = (inst.setupToken || '').toLowerCase();
          // Length-checked before compare so a wrong-length guess cannot throw.
          const ok = expected.length > 0 && given.length === expected.length
            && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
          if (!ok) return json(res, 403, { error: 'That setup code is not right. Check the container log.' });
          setupClaimed = true;
          return json(res, 200, { ok: true });
        }

        if (path === '/setup/claim-pin' && req.method === 'POST') {
          if (!setupClaimed) return json(res, 403, { error: 'Enter the setup code first.' });
          if (setupLimiter.limited(callerKey(req), now())) {
            return json(res, 429, { error: 'too many attempts, try again shortly' });
          }
          const body = await readJsonBody(req) as { id?: number };
          const id = Number(body?.id);
          if (!Number.isFinite(id) || !pendingPins.has(id)) {
            return json(res, 400, { error: 'unknown or expired sign-in' });
          }
          const tok = await claimPin(id, identity);
          if (!tok) return json(res, 202, { pending: true });
          pendingPins.delete(id);
          setupToken = tok;
          // Only servers this account OWNS. You cannot point the store at
          // somebody else's library, and gating on a server you do not own
          // would hand its owner the ability to lock you out by unsharing.
          const resources = await fetchResources(tok, identity);
          if (resources === null) return json(res, 502, { error: 'Could not reach plex.tv to list your servers — try again in a moment.' });
          const servers = (Array.isArray(resources) ? resources : [])
            .filter((r) => r && r.owned === true && typeof r.provides === 'string'
              && r.provides.split(',').some((x: string) => x.trim() === 'server'))
            .map((r) => ({ id: String(r.clientIdentifier), name: String((r as { name?: string }).name || 'Plex Server') }));
          return json(res, 200, { servers });
        }

        if (path === '/setup/finish' && req.method === 'POST') {
          if (!setupClaimed || !setupToken) return json(res, 403, { error: 'Start setup again.' });
          const body = await readJsonBody(req) as { machineId?: string };
          const machineId = String(body?.machineId ?? '').trim();
          // Re-verify against Plex rather than trusting the posted id: the
          // browser could send anything, and this is the one write that decides
          // what the whole gate checks against forever after.
          const resources = await fetchResources(setupToken, identity);
          if (resources === null) return json(res, 502, { error: 'Could not reach plex.tv to verify ownership — try again.' });
          const owns = resources.some((r) => r && r.clientIdentifier === machineId && r.owned === true);
          if (!machineId || !owns) return json(res, 403, { error: 'You do not own that server.' });

          inst.plexMachineId = machineId;
          inst.setupToken = null;   // single use, and the surface closes with it
          cfg.plexMachineId = machineId;
          saveInstance(cfg.databasePath, inst);
          setupToken = null;
          console.log(`[front-door] setup complete — gating Plex server ${machineId}`);
          return json(res, 200, { ok: true });
        }

        if (path === '/healthz') return json(res, 200, { ok: true, setup: 'pending' });
        if (path === '/signin/archivo-black.ttf') { /* fall through to the font route */ }
        else if (path !== '/auth/pin') {
          return json(res, 503, { error: 'This store has not been set up yet.' });
        }
      }

      // Begin sign-in. Deliberately reachable without a session — it is how you
      // get one — so it is the most exposed endpoint in the service.
      //
      // REGISTERS a pin; it does not create one. The viewer's browser mints
      // the pin at plex.tv directly (see signin-page.ts for why that address
      // attribution matters), and tells this endpoint which id to expect.
      // This side never talks to plex.tv here at all — the point of the fix —
      // and the claim is where the one authoritative round trip happens.
      if (path === '/auth/pin' && req.method === 'POST') {
        // Sweep expired registrations on the way in. Cheap, and it keeps an
        // unbounded map from being an easy memory-exhaustion target.
        sweepPins(now());
        if (pinLimiter.limited(callerKey(req), now())) {
          return json(res, 429, { error: 'too many sign-in attempts, try again shortly' });
        }
        if (pendingPins.size > 100) {
          return json(res, 429, { error: 'too many sign-ins in flight, try again shortly' });
        }
        const body = await readJsonBody(req) as { id?: number };
        const id = Number(body?.id);
        // A pin id is a positive integer plex.tv already issued to the
        // browser. Anything else is either a broken page or a probe, and
        // neither gets a slot in the shared table.
        if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) {
          return json(res, 400, { error: 'This page must obtain a sign-in code from plex.tv first.' });
        }
        pendingPins.set(id, { createdAt: now() });
        return json(res, 200, { ok: true });
      }

      // Exchange an authorised pin for a session. THIS is where the gate runs.
      if (path === '/auth/claim' && req.method === 'POST') {
        // One plex.tv round trip per call, from an unauthenticated endpoint:
        // rate-limited tightly, because a legitimate sign-in claims once.
        if (claimLimiter.limited(callerKey(req), now())) {
          return json(res, 429, { error: 'too many sign-in attempts, try again shortly' });
        }
        sweepPins(now());
        const body = await readJsonBody(req) as { id?: number; aspect?: string };
        const id = Number(body?.id);
        if (!Number.isFinite(id) || !pendingPins.has(id)) {
          return json(res, 400, { error: 'unknown or expired sign-in' });
        }

        const token = await claimPin(id, identity);
        if (!token) return json(res, 202, { pending: true });
        pendingPins.delete(id);

        const [account, resources] = await Promise.all([
          fetchAccount(token, identity),
          fetchResources(token, identity),
        ]);
        if (!account) return json(res, 502, { error: 'could not read your Plex account' });
        if (resources === null) return json(res, 502, { error: 'Could not reach plex.tv to check your access — try again in a moment.' });

        // The gate. A valid Plex login is NOT enough — anyone can make a Plex
        // account. This asks whether the owner shared this server with them.
        if (!grantsAccessTo(resources, cfg.plexMachineId)) {
          return json(res, 403, {
            error: 'This store is limited to people with access to its Plex library. '
              + 'Ask the owner to share a library with your Plex account.',
          });
        }

        const owner = isOwnerOf(resources, cfg.plexMachineId);
        db.upsertUser(account.id, account.username, owner, now());
        const sid = db.createSession(account.id, token, owner, now(), body?.aspect);
        const exp = now() + cfg.sessionTtlMs;
        setSessionCookie(req, res, signSession({ sid, uid: account.id, owner, exp }, cfg.sessionSecret), cfg.sessionTtlMs);
        return json(res, 200, { ok: true, username: account.username, owner });
      }

      // ── Authenticated ──────────────────────────────────────────────────────

      const session = currentSession(req);

      if (path === '/auth/signout' && req.method === 'POST') {
        if (session) {
          db.deleteSession(session.payload.sid);
          // Otherwise a token for a signed-out session lingers in memory and
          // would be handed to the next holder of that session id.
          connCache.delete(session.payload.sid);
        }
        clearSessionCookie(req, res);
        // The holding page signs out with a plain <form>, so a browser needs a
        // redirect; fetch callers still get JSON.
        if ((req.headers.accept || '').includes('text/html')) {
          res.writeHead(303, { location: '/' });
          res.end();
          return;
        }
        return json(res, 200, { ok: true });
      }

      if (!session) {
        if (path.startsWith('/api/')) return json(res, 401, { error: 'sign in first' });
        // A browser gets the gate, not a JSON error. 200 rather than 401
        // because this IS the page for this request, not a failure to render
        // one — a 401 with a body makes some clients show their own auth UI.
        return html(res, 200, signInPage(publicOrigin(req, cfg.publicHostname), identity));
      }

      const { payload, token } = session;
      if (!(await revalidate(payload.sid, payload.uid, token))) {
        clearSessionCookie(req, res);
        return json(res, 403, { error: 'your access to this Plex library was removed' });
      }

      // Owner-only status page, reachable deliberately rather than by landing
      // on it. Says who you are and whether the store is up.
      if (path === '/whoami' && req.method === 'GET') {
        const stored = db.getSession(payload.sid);
        return html(res, 200, signedInPage(stored?.uid ?? payload.uid, payload.owner));
      }

      // Reachable from the store: the power menu's project row is repointed
      // here by the bootstrap, and it is a plain link so it works with no
      // script at all.
      if (path === '/signout') {
        db.deleteSession(payload.sid);
        connCache.delete(payload.sid);
        clearSessionCookie(req, res);
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }

      if (path === '/api/me') {
        return json(res, 200, { uid: payload.uid, owner: payload.owner });
      }

      if (path === '/api/config' && req.method === 'GET') {
        return json(res, 200, db.getConfig(payload.uid));
      }

      if (path === '/api/config' && req.method === 'PUT') {
        const body = await readJsonBody(req) as { key?: string; value?: string | null };
        const key = String(body?.key ?? '');

        // Server-side enforcement. The drawer also hides owner-only rows, but
        // this endpoint is one fetch away and a hidden control is not a control.
        const verdict = assertWritable(key, payload.owner);
        if (!verdict.ok) return json(res, 403, { error: verdict.reason });

        // null CLEARS. Absence is meaningful in this app's config model — a
        // library switched back on is expressed by deleting its key, so an
        // empty-string write would not mean the same thing.
        if (body?.value === null || body?.value === undefined) {
          db.clearConfig(payload.uid, key);
        } else {
          db.setConfig(payload.uid, key, String(body.value), now());
        }
        return json(res, 200, { ok: true });
      }

      // The viewer's own Plex server, through the front door. Reaching this
      // line means the request already carried a valid, re-validated session
      // — the same gate the store sits behind, on purpose: the proxy is the
      // ONLY route a browser has to the Plex server, so it must be no easier
      // to pass than the store itself.
      //
      // The upstream address is resolved from the viewer's own token (cached
      // per session) and never appears in the response — not in the bootstrap,
      // not in a redirected playlist, not in an error. A browser that learned
      // it would hold the operator's public IP, which is the leak this pipe
      // exists to close.
      if (plexProxyTarget(req) !== null) {
        const conn = await connectionFor(payload.sid, token);
        if (!conn) {
          return json(res, 502, { error: 'Plex is not reachable right now — try again in a moment.' });
        }
        return proxyPlex(req, res, { upstream: conn.upstream, origins: conn.origins });
      }

      // Everything else is the store itself, proxied from the app process on
      // loopback. Reaching this line means the request already carried a valid,
      // re-validated session — which is the whole point: the store is not
      // served on a port of its own, so there is no way to reach it that
      // bypasses the gate.
      //
      // NOTE this proxies ONE SHARED store to every viewer. Per-user rendering
      // instances (Phase 2) replace it; until then everyone drives the same
      // camera and rendering happens in the viewer's own browser.
      // Only the DOCUMENT is rewritten. Assets stream through untouched, and
      // resolving a connection costs a plex.tv round trip we should not pay on
      // every texture.
      let bootstrap: string | undefined;
      if ((req.headers.accept || '').includes('text/html')) {
        const conn = await connectionFor(payload.sid, token);
        // No connection is not an error. It means this viewer can sign in but
        // cannot currently reach the server — sharing revoked between checks, or
        // Plex not answering. The store then shows its own setup terminal, which
        // is a worse experience than a stocked store and a much better one than
        // a blank screen.
        // Store policy rides along with the connection: which libraries this
        // store carries and whether the games department exists are the
        // owner's decisions, applied to every viewer on every load. Written as
        // the app's OWN settings keys, so the store needs no knowledge of a
        // front door to obey them.
        if (conn) bootstrap = connectionBootstrapScript(conn, payload.uid, policyKeys(loadPolicy(db)));
      }
      proxyToApp(req, res, cfg.appOrigin, bootstrap);
      return;
    } catch (err) {
      // Never leak an internal error to a public caller: the message could name
      // a path, a query or a token. Log it, answer with nothing.
      const ref = randomUUID().slice(0, 8);
      console.error(`[front-door] ${ref}`, err);
      return json(res, 500, { error: 'something went wrong', ref });
    }
  };
}

/** Entry point. Only runs when this module is executed directly. */
export function main(): void {
  const { cfg, instance } = loadConfig();
  const db = new FrontDoorStore(cfg.databasePath, cfg.tokenKey);
  // Say where state lives, every boot. "I can't see any app data" is otherwise
  // impossible to answer from the outside: a Docker named volume is under
  // /var/lib/docker/volumes and invisible to a NAS file browser, and a wrong
  // DATABASE_PATH writes inside the container where it dies with it. One line
  // of log turns that into something checkable.
  console.log(`[front-door] state: ${cfg.databasePath} (+ instance.json beside it)`);
  const handler = createFrontDoor(cfg, db, Date.now, instance);
  startAdminServer(cfg, db, instance, {
    clientId: process.env.PLEX_CLIENT_ID || instance.plexClientId,
    product: process.env.PLEX_PRODUCT || 'VolkBuster Video',
    version: APP_VERSION,
    device: 'VolkBuster Front Door',
    platform: 'Node',
  });
  createServer((req, res) => { void handler(req, res); }).listen(cfg.port, () => {
    if (isConfigured(instance)) {
      console.log(`[front-door] listening on :${cfg.port}, gating Plex server ${instance.plexMachineId}`);
      return;
    }
    // The setup code goes to the log on purpose: reading it is what proves
    // control of the host, and it is the only thing standing between a
    // brand-new store and whoever finds the address first.
    // Drawn through a helper rather than as pre-padded literals. The literals
    // had drifted: three of the six rows sat a character out, because the port
    // row's padEnd had to allow for a variable-width port number and the two
    // prose rows were counted by eye. This is the first thing anyone sees after
    // `docker run`, and a crooked box reads as a broken install.
    const W = 56;
    const rule = (l: string, r: string) => `  ${l}${'\u2500'.repeat(W)}${r}`;
    const row = (text = '') => `  \u2502  ${text.padEnd(W - 2)}\u2502`;
    console.log('');
    console.log(rule('\u250c', '\u2510'));
    console.log(row('VolkBuster Video is not set up yet.'));
    console.log(row());
    console.log(row(`Open  http://<this-host>:${cfg.port}`));
    console.log(row(`Setup code:  ${instance.setupToken}`));
    console.log(row());
    console.log(row('Secrets were generated automatically and stored'));
    console.log(row('beside the database. Nothing to configure by hand.'));
    console.log(rule('\u2514', '\u2518'));
    console.log('');
  });
}

// `node server/index.ts` runs the service; importing it (tests) does not.
if (process.argv[1] && process.argv[1].endsWith('server/index.ts')) main();
