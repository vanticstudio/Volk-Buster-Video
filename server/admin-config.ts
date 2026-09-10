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
}

export const DEFAULT_POLICY: StorePolicy = { hiddenLibraries: [], gamesEnabled: false };

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
  return {
    hiddenLibraries: hidden,
    gamesEnabled: row.games_enabled === '1',
  };
}

export function savePolicy(db: FrontDoorStore, policy: StorePolicy, now: number): void {
  db.setPolicy('hidden_libraries', JSON.stringify(policy.hiddenLibraries), now);
  db.setPolicy('games_enabled', policy.gamesEnabled ? '1' : '0', now);
}

/**
 * Policy as the localStorage keys the store already reads.
 *
 * Only hidden libraries get a key. Writing '1' for every visible one would
 * fight the store's own defaults and pin a library ON even after the owner
 * removes it from policy — absence has to mean "no opinion".
 */
export function policyKeys(policy: StorePolicy): Record<string, string> {
  const out: Record<string, string> = {
    bb_games_enabled: policy.gamesEnabled ? '1' : '0',
  };
  for (const id of policy.hiddenLibraries) out[`bb_carrylib_${id}`] = '0';
  return out;
}
