/**
 * The management console, on its own port.
 *
 * WHY A SECOND PORT rather than a route on the first: the public port is the
 * one behind the tunnel, reachable by everyone the owner shared a library with.
 * The console changes what the store IS, so keeping it on its own port means
 * the tunnel points at 3355 alone — a routing mistake on the public side has
 * nothing to reach. The port is published to the LAN, never routed in.
 *
 * IT STILL AUTHENTICATES. A LAN is not a trust boundary: other people's
 * devices, guest wifi and anything already on the network are all on it. The
 * console requires a Plex sign-in and the owner of the gated server, exactly
 * like the public side, so being on the LAN is necessary and not sufficient.
 *
 * Its own cookie, because cookies ignore ports but not hostnames — an owner
 * reaching the store at a public domain and the console at a LAN address is
 * two different origins, and a shared cookie would work for neither reliably.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { FrontDoorConfig } from './config.ts';
import type { FrontDoorStore } from './store.ts';
import type { InstanceSecrets } from './bootstrap.ts';
import { signSession, verifySession } from './sessions.ts';
import { grantsAccessTo, isOwnerOf } from './plex-gate.ts';
import { createPin, claimPin, fetchAccount, fetchResources, listPlexLibraries, type PlexClientIdentity } from './plex-client.ts';
import { connectionForViewer } from './plex-connection.ts';
import { loadPolicy, savePolicy, type StorePolicy } from './admin-config.ts';
import { CONSOLE_SETTINGS, validateSettings } from './store-settings.ts';
import { adminPage, adminDeniedPage } from './admin-page.ts';
import { signInPage } from './signin-page.ts';
import { checkForUpdates, startUpdate, updateStatus, updateAvailable } from './update-manager.ts';

const COOKIE = 'hv_admin';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(body);
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > 256 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function createAdminServer(
  cfg: FrontDoorConfig,
  db: FrontDoorStore,
  instance: InstanceSecrets,
  identity: PlexClientIdentity,
  now: () => number = Date.now,
) {
  const pins = new Map<number, number>();
  const TTL = 10 * 60_000;

  function session(req: IncomingMessage): { uid: string; token: string; owner: boolean } | null {
    const raw = readCookie(req, COOKIE);
    if (!raw) return null;
    const payload = verifySession(raw, cfg.sessionSecret, now());
    if (!payload) return null;
    const stored = db.getSession(payload.sid);
    if (!stored) return null;
    return { uid: stored.uid, token: stored.token, owner: stored.owner };
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    try {
      if (path === '/healthz') return json(res, 200, { ok: true });

      // The console cannot be set up FROM here. Until a Plex server is chosen
      // on the public port there is no owner to authenticate against, so
      // pointing people at the one place that can do it beats a broken form.
      if (!instance.plexMachineId) {
        return html(res, 503, adminDeniedPage('nobody — this store is not set up yet'));
      }

      // ── Sign-in (its own, see the header on cookies and ports) ────────────
      if (path === '/auth/pin' && req.method === 'POST') {
        for (const [id, at] of pins) if (now() - at > TTL) pins.delete(id);
        if (pins.size > 20) return json(res, 429, { error: 'too many sign-ins in flight' });
        const pin = await createPin(identity);
        pins.set(pin.id, now());
        return json(res, 200, { id: pin.id, code: pin.code, authUrl: pin.authUrl });
      }

      if (path === '/auth/claim' && req.method === 'POST') {
        const body = await readJson(req) as { id?: number };
        const id = Number(body?.id);
        if (!Number.isFinite(id) || !pins.has(id)) return json(res, 400, { error: 'unknown or expired sign-in' });
        const token = await claimPin(id, identity);
        if (!token) return json(res, 202, { pending: true });
        pins.delete(id);

        const [account, resources] = await Promise.all([
          fetchAccount(token, identity),
          fetchResources(token, identity),
        ]);
        if (!account) return json(res, 502, { error: 'could not read your Plex account' });
        // Same gate as the public side. Being on the LAN is not authorisation.
        if (!grantsAccessTo(resources, cfg.plexMachineId)) {
          return json(res, 403, { error: 'That account has no access to this store\'s Plex server.' });
        }
        const owner = isOwnerOf(resources, cfg.plexMachineId);
        db.upsertUser(account.id, account.username, owner, now());
        const sid = db.createSession(account.id, token, owner, now());
        const exp = now() + cfg.sessionTtlMs;
        // No Secure flag: this port is LAN-only over plain HTTP by design, and
        // a Secure cookie there is silently discarded by the browser — the
        // exact bug that made the public side loop on its sign-in page.
        res.setHeader('set-cookie',
          `${COOKIE}=${encodeURIComponent(signSession({ sid, uid: account.id, owner, exp }, cfg.sessionSecret))}`
          + `; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}`);
        return json(res, 200, { ok: true, owner });
      }

      const s = session(req);
      if (!s) return html(res, 200, signInPage());
      if (!s.owner) return html(res, 403, adminDeniedPage(s.uid));

      // ── Owner only, from here ─────────────────────────────────────────────
      if (path === '/' && req.method === 'GET') {
        const policy = loadPolicy(db);
        const conn = await connectionForViewer(s.token, cfg.plexMachineId, identity);
        const libraries = conn
          ? await listPlexLibraries(conn.url, conn.token, cfg.plexMachineId)
          : [];
        return html(res, 200, adminPage({
          username: s.uid,
          libraries,
          hidden: policy.hiddenLibraries,
          gamesEnabled: policy.gamesEnabled,
          settings: policy.settings,
          catalog: CONSOLE_SETTINGS,
          publicPort: cfg.port,
        }));
      }

      if (path === '/api/policy' && req.method === 'PUT') {
        const body = await readJson(req) as Partial<StorePolicy>;
        const hidden = Array.isArray(body?.hiddenLibraries)
          ? body.hiddenLibraries.filter((x): x is string => typeof x === 'string').slice(0, 200)
          : [];
        // REPORTED, not silently dropped. A typo'd value that vanishes without
        // a word sends the owner off to reload the store and wonder why
        // nothing changed; the console can only tell them if we answer.
        const { settings, errors } = validateSettings(body?.settings);
        if (errors.length) return json(res, 400, { error: errors.join(' ') });
        savePolicy(db, {
          hiddenLibraries: hidden,
          gamesEnabled: body?.gamesEnabled === true,
          settings,
        }, now());
        return json(res, 200, { ok: true });
      }

      if (path === '/api/sessions' && req.method === 'DELETE') {
        const revoked = db.deleteAllSessions();
        console.log(`[admin] signed out ${revoked} session(s) at the owner's request`);
        return json(res, 200, { revoked });
      }

      // ── Update manager ────────────────────────────────────────────────────
      if (path === '/api/updates/check' && req.method === 'GET') {
        const info = await checkForUpdates();
        return json(res, 200, { ...info, canApply: updateAvailable() });
      }
      if (path === '/api/updates/apply' && req.method === 'POST') {
        if (!updateAvailable()) {
          return json(res, 409, { error: 'No update script in this install — update the way it was installed (Docker pull, ZimaOS, or a git clone).' });
        }
        const job = startUpdate();
        console.log(`[admin] update started by the owner (job ${job.id})`);
        return json(res, 202, { id: job.id });
      }
      if (path === '/api/updates/status' && req.method === 'GET') {
        const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || '';
        const job = updateStatus(id);
        if (!job) return json(res, 404, { error: 'unknown update job' });
        return json(res, 200, { done: job.done, ok: job.ok, log: job.log.slice(-8000) });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[admin]', err);
      return json(res, 500, { error: 'something went wrong' });
    }
  };
}

/**
 * Start the console.
 *
 * Bound to 0.0.0.0 so it is reachable from the LAN. The compose files and the
 * README's `docker run` publish it to the host on purpose, so an owner can
 * reach it from another machine; what must never happen is routing it in from
 * outside, through a tunnel or a router forward. ADMIN_PORT=0 switches it off.
 */
export function startAdminServer(
  cfg: FrontDoorConfig,
  db: FrontDoorStore,
  instance: InstanceSecrets,
  identity: PlexClientIdentity,
): void {
  const port = Number(process.env.ADMIN_PORT ?? 3366);
  if (!Number.isFinite(port) || port <= 0) {
    console.log('[admin] disabled (ADMIN_PORT=0)');
    return;
  }
  const handler = createAdminServer(cfg, db, instance, identity);
  createServer((req, res) => { void handler(req, res); }).listen(port, () => {
    console.log(`[admin] management console on :${port} — owner only, LAN only: never route this port in through a tunnel or a router forward`);
  });
}
