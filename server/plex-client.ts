/**
 * The plex.tv calls the front door makes — the pin claim that completes a
 * sign-in, and the resource list the access gate decides on.
 *
 * Kept apart from plex-gate.ts on purpose: the DECISION about who gets in is
 * pure and exhaustively tested, and this file is the I/O that feeds it. Mixing
 * them would make the security rule untestable without a network.
 *
 * THE PIN IS NOT CREATED HERE, and that is deliberate. Plex's OAuth popup
 * shows the person signing in the IP address of the device that created and
 * polls the pin — and every request this process makes to plex.tv leaves via
 * the home WAN, around the Cloudflare tunnel. A pin minted here would print
 * the operator's home IP to every viewer who signed in. The viewer's browser
 * creates the pin (src/plex-signin.ts's dance, moved onto the gate page), so
 * the popup attributes the sign-in to the viewer's own address; this side
 * only CLAIMS the pin, once, after the popup has done its job — which also
 * takes the sign-in path from a plex.tv round trip every two seconds down to
 * exactly one.
 */

import type { PlexResource } from './plex-gate.ts';

const PLEX_TV = 'https://plex.tv';

// Every plex.tv/server call gets a hard deadline. Without one, a hung plex.tv
// (or a wedged server behind a NAT) holds the caller — which is a viewer's
// request path on revalidation and the console's page load — for undici's
// 300s default. 10s is generous for an API round trip and short enough that
// a stuck call reads as an outage, not a hang.
const PLEX_TV_TIMEOUT_MS = 10_000;

/** Identifies this application to plex.tv. Shown in the user's device list. */
export interface PlexClientIdentity {
  /** Stable per-install id. Plex keys session eviction off this — see below. */
  clientId: string;
  product: string;
  version: string;
  device: string;
  platform: string;
}

/**
 * Plex wants these on every call, and several of them are load-bearing:
 *
 * `X-Plex-Client-Identifier` MUST be stable for the life of the install. Plex
 * treats a changing identifier as a new device every time, which both clutters
 * the user's device list and — because Plex keys session eviction off it — can
 * retire tokens belonging to other installs.
 */
function plexHeaders(identity: PlexClientIdentity, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Product': identity.product,
    'X-Plex-Version': identity.version,
    'X-Plex-Client-Identifier': identity.clientId,
    'X-Plex-Device': identity.device,
    'X-Plex-Platform': identity.platform,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

/**
 * Claim a pin the viewer's browser created and authorised on plex.tv.
 *
 * Returns the token once the viewer approves, null while still pending. A
 * pending pin is not an error — it means the person is still in the popup, or
 * the claim raced a hair ahead of their approval, and the sign-in page
 * retries briefly before giving up.
 *
 * The identifier must be the one the pin was created with (src/plex.ts
 * documents plex.tv answering 400 otherwise), which is why the gate page
 * creates pins under this install's clientId rather than one of its own.
 */
export async function claimPin(id: number, identity: PlexClientIdentity): Promise<string | null> {
  const res = await fetch(`${PLEX_TV}/api/v2/pins/${id}`, {
    headers: plexHeaders(identity),
    signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json() as { authToken: string | null };
  return body.authToken || null;
}

/** Who this token belongs to. */
export interface PlexAccount {
  id: string;
  username: string;
}

export async function fetchAccount(token: string, identity: PlexClientIdentity): Promise<PlexAccount | null> {
  const res = await fetch(`${PLEX_TV}/api/v2/user`, { headers: plexHeaders(identity, token), signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = await res.json() as { id: number | string; username?: string; title?: string };
  if (body?.id === undefined || body.id === null) return null;
  return { id: String(body.id), username: body.username || body.title || 'plex user' };
}

/**
 * Every server this token can reach — the input to the access gate.
 *
 * THREE-WAY, and the distinction is load-bearing:
 *   - a non-empty array — answered: the account reaches those servers.
 *   - an EMPTY array — answered: the account reaches nothing (revoked,
 *     fresh account). Fail-closed is correct wherever a yes/no is required.
 *   - NULL — the question could NOT be answered (network error, non-200,
 *     malformed body). Callers on the sign-in path fail closed with an
 *     honest "plex.tv unreachable" error; the SESSION re-validation path
 *     must treat null as "keep the session" — an unanswered question is not
 *     a revocation, and wiping someone's sessions because plex.tv 500'd is
 *     the destructive bug this distinction exists to prevent.
 */
export async function fetchResources(token: string, identity: PlexClientIdentity): Promise<PlexResource[] | null> {
  try {
    const res = await fetch(`${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1`, {
      headers: plexHeaders(identity, token),
      signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? body as PlexResource[] : null;
  } catch {
    return null;
  }
}

export interface PlexLibrary {
  /** Namespaced the way the store's own settings key it: `<sourceId>:<key>`. */
  id: string;
  title: string;
  type: string;
}

/**
 * The libraries on a server, for the management console's visibility list.
 *
 * Talks to the SERVER directly rather than plex.tv, because plex.tv knows which
 * servers exist but not what is inside them.
 *
 * Ids come back already namespaced, because that is the form the store's
 * `bb_carrylib_*` settings use and the console's job is to produce exactly
 * those keys. Doing it here keeps the namespacing rule in one place instead of
 * being re-derived by every caller that thinks it knows the format.
 */
export async function listPlexLibraries(
  serverUrl: string,
  token: string,
  sourceId: string,
): Promise<PlexLibrary[]> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/library/sections`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      signal: AbortSignal.timeout(PLEX_TV_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = await res.json() as { MediaContainer?: { Directory?: Array<Record<string, unknown>> } };
    const dirs = body?.MediaContainer?.Directory;
    if (!Array.isArray(dirs)) return [];
    return dirs
      .filter((d) => d && (typeof d.key === 'string' || typeof d.key === 'number'))
      .map((d) => ({
        id: `${sourceId}:${String(d.key)}`,
        title: typeof d.title === 'string' ? d.title : `Library ${String(d.key)}`,
        type: typeof d.type === 'string' ? d.type : 'unknown',
      }));
  } catch {
    // An unreachable server is an empty list, not a crash: the console still
    // renders and says so, which is more useful than a 500.
    return [];
  }
}
