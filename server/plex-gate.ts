/**
 * The access gate — who is allowed into this store.
 *
 * This fork is reachable on the public internet through a Cloudflare Tunnel,
 * and this module is the whole authorisation model. Everything else in the
 * front door is plumbing around the two decisions made here.
 *
 * THE RULE: a viewer is allowed in when the Plex account behind their token can
 * reach THIS server — the one named by `PLEX_MACHINE_ID`. That set is exactly
 * the people the owner shared a library with, so access follows Plex sharing
 * and is revoked by unsharing it. No allowlist, no second source of truth.
 *
 * THE TRAP THIS AVOIDS: a successful Plex sign-in proves only that someone has
 * a Plex account, which anyone can create in about a minute. It says nothing
 * about whether they were shared anything. Treating authentication as
 * authorisation would leave the library open to the entire internet, and the
 * failure would be invisible — everything would appear to work.
 *
 * Deliberately pure and network-free so it can be tested exhaustively without a
 * Plex account (tests/plex-gate.test.ts). The HTTP that fetches these rows
 * lives in plex-client.ts.
 */

/** One row of `GET https://plex.tv/api/v2/resources`, narrowed to what we use. */
export interface PlexResource {
  /** Stable per-server id. This is what `PLEX_MACHINE_ID` names. */
  clientIdentifier: string;
  /** Comma-joined roles, e.g. `"server"` or `"server,player"`. */
  provides: string;
  /** True when the account behind the token owns this resource. */
  owned: boolean;
  /** True when the resource is reached via a Plex Home relationship. */
  home: boolean;
}

/**
 * Find the row for `machineId`, or null.
 *
 * Every guard that matters lives here so both exported decisions inherit it:
 *
 * - An empty/absent `machineId` matches NOTHING. A missing configuration is a
 *   deployment mistake, and the tempting reading — "nothing configured, so
 *   match anything" — would admit the entire internet. Fail closed.
 * - Matching is exact and case-sensitive. Plex identifiers are opaque; a
 *   prefix or case-insensitive match would widen the door for no benefit.
 * - A row must actually `provides` a server. The same endpoint returns players
 *   and controllers, and only a server can be the library being gated.
 * - Malformed rows are skipped rather than trusted. This list arrives over the
 *   network from a third party; a row missing the fields we check is not
 *   evidence of anything.
 */
function serverRow(resources: readonly PlexResource[], machineId: string): PlexResource | null {
  if (!machineId) return null;
  if (!Array.isArray(resources)) return null;

  for (const row of resources) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.clientIdentifier !== 'string' || typeof row.provides !== 'string') continue;
    if (row.clientIdentifier !== machineId) continue;
    // "server,player" is a real shape — check roles, not the whole string.
    // `role` is annotated because the Array.isArray guard above widens `row`
    // to any, which would otherwise make this an implicit-any under strict.
    if (!row.provides.split(',').some((role: string) => role.trim() === 'server')) continue;
    return row;
  }
  return null;
}

/**
 * May the account behind this token enter the store?
 *
 * True for the owner and for everyone the owner shared a library with — Plex
 * reports both as reachable resources. Anything else, including a perfectly
 * valid Plex account that simply has no relationship to this server, is false.
 */
export function grantsAccessTo(resources: readonly PlexResource[], machineId: string): boolean {
  return serverRow(resources, machineId) !== null;
}

/**
 * Is this account the OWNER of the store?
 *
 * Taken from what Plex reports about this specific server rather than from a
 * configured account id. That means there is no second place for it to be
 * wrong, nothing to keep in sync, and no way to promote a guest to admin by
 * mistyping a number in an env file.
 *
 * Owning some OTHER server is irrelevant here: it makes you an owner
 * somewhere, not an admin of this one. That case is a guest.
 */
export function isOwnerOf(resources: readonly PlexResource[], machineId: string): boolean {
  return serverRow(resources, machineId)?.owned === true;
}
