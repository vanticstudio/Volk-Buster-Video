/**
 * Machine secrets and first-run state, generated rather than typed.
 *
 * WHY THIS EXISTS: the first version of this service required an operator to
 * paste SESSION_SECRET and TOKEN_ENCRYPTION_KEY into a compose file. That was
 * the wrong shape. They are not decisions — they are random bytes, and a human
 * in the loop can only make them worse: weaker entropy, copied through a
 * clipboard, pasted into a file that ends up in a screenshot or a git repo.
 *
 * The server generates them on first boot and keeps them beside its database.
 * An operator never sees them and never has to.
 *
 * ENV STILL WINS where it is set, for the deployment that manages secrets
 * externally (Docker secrets, a vault, a CI-provisioned host). That path is
 * unchanged; it is just no longer the only one.
 *
 * IF THE FILE IS LOST, so are all sessions: stored Plex tokens were encrypted
 * with the old key and become undecryptable, and every cookie fails its
 * signature. That is self-healing — everyone signs in again — and it is why the
 * file lives in the same volume as the database rather than in the image.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface InstanceSecrets {
  sessionSecret: string;
  tokenKey: string;
  /** One-time token that authorises first-run setup. Cleared once claimed. */
  setupToken: string | null;
  /** The Plex server this store gates on. Null until setup finishes. */
  plexMachineId: string | null;
  /** Stable per-install id presented to plex.tv. Never changes once written. */
  plexClientId: string;
}

function fresh(): InstanceSecrets {
  return {
    sessionSecret: randomBytes(32).toString('hex'),
    tokenKey: randomBytes(32).toString('hex'),
    // Short enough to read off a terminal and retype, long enough that
    // guessing it is not a strategy. It only has to survive the minutes
    // between `docker logs` and finishing setup.
    setupToken: randomBytes(6).toString('hex'),
    plexMachineId: null,
    // Plex keys session eviction off this. Generated once and persisted,
    // because a value that changed per restart would look like a brand-new
    // device every boot and can retire tokens belonging to other clients.
    plexClientId: `volkbuster-${randomBytes(8).toString('hex')}`,
  };
}

/**
 * Load the instance file, creating it on first boot.
 *
 * Written 0600. It holds the key that decrypts every viewer's Plex token, so
 * the default umask is not good enough — on a NAS whose volumes are frequently
 * world-readable by design, mode is the only thing protecting it.
 */
export function loadInstance(dataPath: string): InstanceSecrets {
  const file = join(dirname(dataPath), 'instance.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstanceSecrets>;
    if (typeof parsed.sessionSecret === 'string' && typeof parsed.tokenKey === 'string') {
      return {
        sessionSecret: parsed.sessionSecret,
        tokenKey: parsed.tokenKey,
        setupToken: typeof parsed.setupToken === 'string' ? parsed.setupToken : null,
        plexMachineId: typeof parsed.plexMachineId === 'string' ? parsed.plexMachineId : null,
        plexClientId: typeof parsed.plexClientId === 'string'
          ? parsed.plexClientId
          : `volkbuster-${randomBytes(8).toString('hex')}`,
      };
    }
    // Present but unusable. Refuse rather than silently regenerating: a new key
    // would orphan every stored token, and doing that quietly on a corrupt read
    // turns a recoverable file problem into everyone being logged out.
    throw new Error(`${file} exists but is missing sessionSecret/tokenKey. Move it aside to start fresh.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const created = fresh();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(created, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* filesystems without mode bits */ }
  return created;
}

/** Persist a change — used when setup completes. */
export function saveInstance(dataPath: string, next: InstanceSecrets): void {
  const file = join(dirname(dataPath), 'instance.json');
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** True once a Plex server has been chosen and the store is gating on it. */
export function isConfigured(inst: InstanceSecrets): boolean {
  return typeof inst.plexMachineId === 'string' && inst.plexMachineId.length > 0;
}
