/**
 * Store policy the owner sets once, applied to every viewer.
 *
 * SEPARATE FROM PER-VIEWER SETTINGS on purpose. A viewer choosing a 1993
 * fit-out is their business; which libraries the store carries at all is the
 * owner's. The front door already keeps per-user config in SQLite; this is the
 * other half — one row that applies to everybody.
 *
 * IT EXPRESSES ITSELF THROUGH THE APP'S OWN SETTINGS rather than inventing a
 * parallel mechanism. The store already understands `bb_carrylib_<source>:<id>`
 * ("does this store carry that library") and `bb_games_enabled`. Policy is
 * therefore just those keys, written into the connection bootstrap on every
 * document load, which means it applies without the store needing to know a
 * front door exists.
 *
 * WHAT IT IS NOT: a security boundary. Hiding a library stops it being STOCKED;
 * it does not stop a determined viewer asking Plex for it directly with the
 * token their own browser holds. Plex's own sharing is the boundary — if
 * someone must not see a library, unshare it there. This is merchandising.
 */

import type { FrontDoorStore } from './store.ts';
import { RESERVED_KEYS } from './store-settings.ts';

export interface StorePolicy {
  /**
   * Library ids the store must NOT carry, namespaced `<sourceId>:<libraryId>`.
   * A denylist rather than an allowlist so a library added in Plex later shows
   * up by default — the alternative silently hides new libraries until someone
   * remembers to come here.
   */
  hiddenLibraries: string[];
  /** The games department. Off unless RomM is configured anyway. */
  gamesEnabled: boolean;
  /**
   * Store settings the owner has actually touched, as the app's own keys.
   *
   * SPARSE ON PURPOSE. A key absent here means "no opinion" and nothing is
   * emitted, so the store's own default applies — the same convention
   * hiddenLibraries uses, and what keeps an owner who only wanted to change
   * the theme from silently pinning thirty other values as a side effect.
   *
   * A key PRESENT here is enforced on every document load. Reverting a setting
   * therefore writes its default explicitly rather than deleting the key:
   * deleting would stop the broadcast and strand every viewer on the last
   * value the owner enforced, with no way to pull them back. Same reasoning as
   * bb_games_enabled, which has always been stated rather than implied.
   */
  settings: Record<string, string>;
}

export const DEFAULT_POLICY: StorePolicy = { hiddenLibraries: [], gamesEnabled: false, settings: {} };

export function loadPolicy(db: FrontDoorStore): StorePolicy {
  const row = db.getPolicy();
  let hidden: string[] = [];
  try {
    const parsed = JSON.parse(row.hidden_libraries || '[]');
    if (Array.isArray(parsed)) hidden = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // A corrupt row must not take the store down. Carrying everything is the
    // safe failure here: an owner notices a library they meant to hide far
    // sooner than they notice one that vanished.
  }
  let settings: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.settings || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        // Re-checked on the way OUT as well as in. A row written by an older
        // build, or edited on disk, must not be able to name a front-door key.
        if (typeof v === 'string' && !RESERVED_KEYS.has(k)) settings[k] = v;
      }
    }
  } catch {
    // Same tolerance as hiddenLibraries above: this is read on every document
    // load, and a bad blob must not be able to take the store down.
    settings = {};
  }
  return {
    hiddenLibraries: hidden,
    gamesEnabled: row.games_enabled === '1',
    settings,
  };
}

export function savePolicy(db: FrontDoorStore, policy: StorePolicy, now: number): void {
  db.setPolicy('hidden_libraries', JSON.stringify(policy.hiddenLibraries), now);
  db.setPolicy('games_enabled', policy.gamesEnabled ? '1' : '0', now);
  db.setPolicy('settings', JSON.stringify(policy.settings ?? {}), now);
}

/**
 * Policy as the localStorage keys the store already reads.
 *
 * Only hidden libraries get a key. Writing '1' for every visible one would
 * fight the store's own defaults and pin a library ON even after the owner
 * removes it from policy — absence has to mean "no opinion".
 */
export function policyKeys(policy: StorePolicy): Record<string, string> {
  // The settings map goes FIRST so the dedicated fields below always win a
  // collision. validateSettings already refuses the front door's own keys, and
  // loadPolicy strips them again on read; this is the third guard, and the one
  // that holds even if a future caller builds a policy object by hand.
  const out: Record<string, string> = { ...(policy.settings ?? {}) };
  out.bb_games_enabled = policy.gamesEnabled ? '1' : '0';
  for (const id of policy.hiddenLibraries) out[`bb_carrylib_${id}`] = '0';
  return out;
}
