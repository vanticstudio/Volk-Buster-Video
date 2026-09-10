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
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is required. See docs/architecture/2026-09-06-plex-only-streaming-fork.md §11.`,
    );
  }
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export function loadConfig(): FrontDoorConfig {
  return {
    port: num('PORT', 8080),
    plexMachineId: required('PLEX_MACHINE_ID'),
    sessionSecret: required('SESSION_SECRET'),
    tokenKey: deriveKey(required('TOKEN_ENCRYPTION_KEY')),
    databasePath: process.env.DATABASE_PATH || './store.db',
    sessionTtlMs: num('SESSION_TTL_MS', 30 * 24 * 3600_000),      // 30 days
    revalidateAfterMs: num('REVALIDATE_AFTER_MS', 24 * 3600_000), // 1 day
    distDir: process.env.DIST_DIR || './dist',
    appOrigin: process.env.APP_ORIGIN || 'http://127.0.0.1:1420',
  };
}
