/**
 * The front door's database — users, sessions and per-user store settings.
 *
 * Uses `node:sqlite`, built into Node 22.5+, so the whole front door adds no
 * runtime dependency to a project that ships five.
 *
 * WHY THIS EXISTS AT ALL: upstream synced a person's store settings through
 * *Jellyfin's* DisplayPreferences (src/jellyfin.ts, DISPLAY_PREFS_CLIENT).
 * Dropping Jellyfin removed that, and Plex has no equivalent — there is nowhere
 * on a Plex server to park a blob of per-user app config. So the settings store
 * had to come home, and once it was here the session and user tables cost
 * nothing extra.
 *
 * The instance layer (a later phase) hangs off `sessions.client_aspect` and the
 * per-user config rows: an instance is spawned at the viewer's aspect ratio and
 * hydrated from their settings BEFORE the app's module body runs, because
 * several modules read settings synchronously at import time.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { encryptToken, decryptToken } from './secrets.ts';

export interface StoredSession {
  sid: string;
  uid: string;
  owner: boolean;
  /** Decrypted Plex token. Never leaves the server. */
  token: string;
  createdAt: number;
  lastValidatedAt: number;
}

export class FrontDoorStore {
  private db: DatabaseSync;
  // Declared explicitly rather than as a constructor parameter property:
  // `node --experimental-strip-types`, which runs this project's whole test
  // suite, cannot compile `constructor(private key: Buffer)` — strip-only mode
  // erases types but will not synthesise the assignment a parameter property
  // implies. Every server module has to stay inside that subset to be testable.
  private key: Buffer;

  constructor(path: string, key: Buffer) {
    this.key = key;
    this.db = new DatabaseSync(path);
    // WAL: the instance manager reads config while HTTP handlers write it, and
    // the default rollback journal makes those block each other.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        plex_user_id  TEXT PRIMARY KEY,
        username      TEXT,
        is_owner      INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        sid               TEXT PRIMARY KEY,
        plex_user_id      TEXT NOT NULL REFERENCES users(plex_user_id),
        token_encrypted   TEXT NOT NULL,
        is_owner          INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        last_validated_at INTEGER NOT NULL,
        client_aspect     TEXT
      );

      -- Per-user store settings. This is what replaced Jellyfin's
      -- DisplayPreferences; the composite key is what makes two viewers' stores
      -- independent.
      CREATE TABLE IF NOT EXISTS user_config (
        plex_user_id TEXT NOT NULL REFERENCES users(plex_user_id),
        key          TEXT NOT NULL,
        value        TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (plex_user_id, key)
      );

      -- Instance-wide policy: the owner's decisions, applied to every viewer.
      -- Its own table rather than a reserved row in user_config, because that
      -- table has a foreign key to users and policy belongs to no user — the
      -- constraint correctly refused the shortcut.
      CREATE TABLE IF NOT EXISTS store_policy (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(plex_user_id);
    `);
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  upsertUser(uid: string, username: string, isOwner: boolean, now: number): void {
    this.db.prepare(`
      INSERT INTO users (plex_user_id, username, is_owner, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plex_user_id) DO UPDATE SET
        username = excluded.username,
        is_owner = excluded.is_owner,
        last_seen_at = excluded.last_seen_at
    `).run(uid, username, isOwner ? 1 : 0, now, now);
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /** Create a session and return its id. The token is encrypted on the way in. */
  createSession(uid: string, token: string, isOwner: boolean, now: number, aspect?: string): string {
    const sid = randomUUID();
    this.db.prepare(`
      INSERT INTO sessions
        (sid, plex_user_id, token_encrypted, is_owner, created_at, last_validated_at, client_aspect)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sid, uid, encryptToken(token, this.key), isOwner ? 1 : 0, now, now, aspect ?? null);
    return sid;
  }

  /**
   * Look up a session by id.
   *
   * Returns null when the row is gone OR its token cannot be decrypted. A row
   * that survives a key rotation is not a usable session — treating it as one
   * would seed an instance with a null token and produce an empty store rather
   * than an honest sign-in prompt.
   */
  getSession(sid: string): StoredSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    const token = decryptToken(String(row.token_encrypted), this.key);
    if (token === null) return null;
    return {
      sid: String(row.sid),
      uid: String(row.plex_user_id),
      owner: Number(row.is_owner) === 1,
      token,
      createdAt: Number(row.created_at),
      lastValidatedAt: Number(row.last_validated_at),
    };
  }

  touchSession(sid: string, now: number): void {
    this.db.prepare('UPDATE sessions SET last_validated_at = ? WHERE sid = ?').run(now, sid);
  }

  deleteSession(sid: string): void {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  }

  /** Sign a user out everywhere — used when re-validation finds access revoked. */
  deleteSessionsForUser(uid: string): void {
    this.db.prepare('DELETE FROM sessions WHERE plex_user_id = ?').run(uid);
  }

  /**
   * Sign EVERY viewer out. Returns how many sessions went.
   *
   * The owner's lever for "I just unshared a library and want that to bite
   * now", rather than at each viewer's next scheduled re-validation. Nobody
   * loses access by this — anyone still shared with signs straight back in.
   */
  deleteAllSessions(): number {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    this.db.prepare('DELETE FROM sessions').run();
    return Number(n) || 0;
  }

  // ─── Per-user config ───────────────────────────────────────────────────────

  /** Every setting for one viewer, as the `bb_*` map an instance hydrates from. */
  getConfig(uid: string): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM user_config WHERE plex_user_id = ?')
      .all(uid) as Array<Record<string, unknown>>;
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.key)] = String(r.value);
    return out;
  }

  setConfig(uid: string, key: string, value: string, now: number): void {
    this.db.prepare(`
      INSERT INTO user_config (plex_user_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plex_user_id, key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at
    `).run(uid, key, value, now);
  }

  /**
   * Delete a setting.
   *
   * Absence is meaningful in this app's config model — upstream's
   * `applyConfigSnapshot` treats an omitted key as CLEARED, not untouched,
   * because "switch a library back on" is expressed by deleting its key. So
   * removal has to be a real operation, not an empty-string write.
   */
  clearConfig(uid: string, key: string): void {
    this.db.prepare('DELETE FROM user_config WHERE plex_user_id = ? AND key = ?').run(uid, key);
  }

  // ─── Instance-wide policy ──────────────────────────────────────────────

  getPolicy(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM store_policy')
      .all() as Array<Record<string, unknown>>;
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.key)] = String(r.value);
    return out;
  }

  setPolicy(key: string, value: string, now: number): void {
    this.db.prepare(`
      INSERT INTO store_policy (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  }

  close(): void {
    this.db.close();
  }
}
