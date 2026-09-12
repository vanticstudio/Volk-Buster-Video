/**
 * Front-door configuration, read once at start-up and validated loudly.
 *
 * This service holds other people's Plex credentials and stands between the
 * public internet and a media library, so a misconfiguration must stop the
 * process rather than produce a server that appears to work. Every check here
 * exists because its absence would fail silently and dangerously:
 *
 *  - No PLEX_MACHINE_ID and the gate matches nothing, so nobody can sign in —
 *    which at least fails closed, but looks like a Plex outage for hours.
 *  - No SESSION_SECRET and sessions are either unsigned or signed with a
 *    default, which means anyone can mint one.
 *  - No TOKEN_ENCRYPTION_KEY and the database becomes a plaintext credential
 *    store for everyone the owner shared with.
 *
 * None of those announce themselves in normal use. Refusing to boot does.
 */

import { deriveKey } from './secrets.ts';
import { loadInstance, type InstanceSecrets } from './bootstrap.ts';

export interface FrontDoorConfig {
  port: number;
  /** Machine identifier of the Plex server this store gates on. */
  plexMachineId: string;
  sessionSecret: string;
  tokenKey: Buffer;
  databasePath: string;
  /** How long a signed-in session lasts before a fresh Plex sign-in. */
  sessionTtlMs: number;
  /** How often a live session is re-checked against Plex sharing. */
  revalidateAfterMs: number;
  /** Where the built client is served from. */
  distDir: string;
  /** Origin of the internal store app (vite preview), loopback only. */
  appOrigin: string;
  /**
   * The public hostname this store is reached by, when the operator pins it.
   *
   * The gate page builds its link-preview card from the request's Host header,
   * which is attacker-controlled; the escaping and the shape check make a
   * forged host harmless, and leaving this unset keeps LAN access natural
   * (the card simply names whatever address the visitor used). Setting this
   * pins the card to the one name the tunnel routes — everything else yields
   * a card-less page.
   */
  publicHostname: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

/**
 * Build the runtime config.
 *
 * NOTHING HERE IS REQUIRED OF AN OPERATOR ANY MORE. The two secrets are random
 * bytes the server generates on first boot (bootstrap.ts), and the Plex server
 * is chosen through the setup page rather than pasted out of an API URL. Asking
 * a human for those was the wrong shape: one is a job a machine does strictly
 * better, and the other is a decision that deserves a list to pick from.
 *
 * Environment still wins where it is set, for deployments that manage secrets
 * externally. That path is unchanged; it is simply no longer the only one.
 */
export function loadConfig(): { cfg: FrontDoorConfig; instance: InstanceSecrets } {
  const databasePath = process.env.DATABASE_PATH || './store.db';
  const instance = loadInstance(databasePath);
  if (process.env.PLEX_MACHINE_ID) instance.plexMachineId = process.env.PLEX_MACHINE_ID;

  const cfg: FrontDoorConfig = {
    // 3355 is the ONE public port. The store app stays on loopback behind the
    // proxy, so this is the only thing cloudflared or a router should ever see.
    port: num('PORT', 3355),
    // Empty until setup finishes. grantsAccessTo() treats that as "match
    // nothing", so an unconfigured store admits no one — and index.ts routes
    // every visitor to setup rather than to a gate that can never open.
    plexMachineId: instance.plexMachineId || '',
    sessionSecret: process.env.SESSION_SECRET || instance.sessionSecret,
    tokenKey: deriveKey(process.env.TOKEN_ENCRYPTION_KEY || instance.tokenKey),
    databasePath,
    sessionTtlMs: num('SESSION_TTL_MS', 30 * 24 * 3600_000),      // 30 days
    revalidateAfterMs: num('REVALIDATE_AFTER_MS', 24 * 3600_000), // 1 day
    distDir: process.env.DIST_DIR || './dist',
    appOrigin: process.env.APP_ORIGIN || 'http://127.0.0.1:1420',
    publicHostname: (process.env.PUBLIC_HOSTNAME || '').trim(),
  };
  return { cfg, instance };
}
