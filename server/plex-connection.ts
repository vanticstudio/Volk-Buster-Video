/**
 * Hand the store app a working Plex connection, so a viewer never configures
 * one.
 *
 * THE GAP THIS CLOSES: there were two unrelated Plex configurations. The front
 * door knew which server to GATE on and held each viewer's token; the store app
 * separately asked every viewer, in their own browser, which server to STOCK
 * from. Nothing joined them, so a viewer who had just been admitted by their
 * Plex account was met by the store's own "pick a distributor" terminal — and
 * because the store renders in each viewer's browser, every one of them would
 * have had to do it, and would have needed the server's address to do it with.
 *
 * The front door already knows all of it. This turns what it knows into the
 * shape the store reads at boot.
 *
 * ON HANDING THE BROWSER A PLEX TOKEN: it is that viewer's OWN token, delivered
 * over their authenticated session, and the store has to talk to Plex directly
 * to fetch artwork and stream video. Plex's own web client works exactly this
 * way. What is NOT done is handing anyone the owner's token, or a token for a
 * server they were not admitted to: the connection is resolved from the
 * requester's own credentials every time.
 */

import type { PlexClientIdentity } from './plex-client.ts';
import { fetchResources } from './plex-client.ts';

export interface StoreConnection {
  /** Base URL the browser should talk to. */
  url: string;
  /** Per-server access token for THIS viewer. Not their account token. */
  token: string;
  machineId: string;
  name: string;
}

interface PlexConnectionEntry {
  uri: string;
  local: boolean;
  relay: boolean;
  protocol: string;
  address: string;
}

/**
 * Choose which of a server's advertised addresses the browser should use.
 *
 * Plex advertises several per server and they are not interchangeable:
 *
 *  - A LAN address is fastest and lowest-latency, but only reachable from the
 *    same network. A viewer on their phone across town cannot use it, and the
 *    failure is a long hang rather than a clean error.
 *  - A plex.direct HTTPS address works from anywhere and carries a real
 *    certificate, which matters because the store itself is served over HTTPS
 *    and a browser refuses to let an HTTPS page fetch from plain HTTP.
 *  - A relay address works when nothing else does, but Plex rate-limits and
 *    bandwidth-caps it, so it is a last resort rather than a default.
 *
 * Preferring HTTPS non-relay is therefore not a stylistic choice: on a store
 * reachable over a public HTTPS domain, a LAN or plain-HTTP address is one the
 * browser will refuse outright as mixed content.
 */
export function pickConnection(connections: readonly PlexConnectionEntry[]): string | null {
  if (!Array.isArray(connections) || connections.length === 0) return null;
  const usable = connections.filter((c) => c && typeof c.uri === 'string' && c.uri);

  const https = usable.filter((c) => c.protocol === 'https' && !c.relay);
  // Remote before local: a local URI only helps viewers on the same LAN, and
  // the ones who are can still reach the remote address.
  const remoteHttps = https.find((c) => !c.local);
  if (remoteHttps) return remoteHttps.uri;
  if (https.length) return https[0].uri;

  const relay = usable.find((c) => c.relay);
  if (relay) return relay.uri;

  return usable[0].uri;
}

/**
 * Resolve the connection for one viewer, from their own token.
 *
 * Returns null when this account cannot reach the gated server — which the gate
 * should already have prevented, but is re-derived here rather than assumed:
 * this is what decides which server a browser is told to talk to, and it should
 * not be reachable by anything but the requester's real credentials.
 */
export async function connectionForViewer(
  viewerToken: string,
  machineId: string,
  identity: PlexClientIdentity,
): Promise<StoreConnection | null> {
  if (!viewerToken || !machineId) return null;
  const resources = await fetchResources(viewerToken, identity);

  const server = resources.find((r) => {
    if (!r || r.clientIdentifier !== machineId) return false;
    return typeof r.provides === 'string'
      && r.provides.split(',').some((role: string) => role.trim() === 'server');
  }) as (typeof resources[number] & {
    connections?: PlexConnectionEntry[];
    accessToken?: string;
    name?: string;
  }) | undefined;

  if (!server) return null;

  const url = pickConnection(server.connections || []);
  // The per-resource accessToken, not the account token: it is scoped to this
  // one server, so a leak from the browser cannot reach the viewer's other
  // servers or their Plex account.
  const token = server.accessToken || viewerToken;
  if (!url) return null;

  return { url: url.replace(/\/$/, ''), token, machineId, name: server.name || 'Plex' };
}

/**
 * The inline script injected ahead of the app's own module.
 *
 * It writes localStorage rather than calling an API because the app reads these
 * keys SYNCHRONOUSLY at module-evaluation time — several modules resolve
 * settings before any promise could resolve — so anything asynchronous would
 * land after the store had already decided it was unconfigured.
 *
 * The `jellyfin_*` key names are legacy and no longer describe what they hold:
 * saveMediaSources() mirrors source[0] into them regardless of backend, so on
 * this Plex-only fork the key called `jellyfin_url` holds a Plex address.
 * Renaming them would orphan existing installs, so they stay.
 */
export function connectionBootstrapScript(conn: StoreConnection, userId: string): string {
  const source = {
    id: conn.machineId,
    kind: 'plex',
    url: conn.url,
    token: conn.token,
    userId: '',
    name: conn.name,
  };
  const payload = JSON.stringify({
    media_sources: JSON.stringify([source]),
    provider_kind: 'plex',
    jellyfin_url: conn.url,
    jellyfin_token: conn.token,
    jellyfin_userid: '',
    plex_user_id: userId,
  });

  // ESCAPE `<` BEFORE THIS GOES INTO AN INLINE <script>. JSON.stringify quotes
  // and escapes quotes, but it does NOT escape `/` — so a Plex server named
  // `</script><script>alert(1)` survives stringify intact, closes this tag and
  // executes as markup. Server names are user-controlled, and a viewer with a
  // hostile one would be running script in the store's own origin, next to
  // everyone's session cookie.
  //
  // \u003c is inert inside a JS string literal and identical once parsed, so
  // this costs nothing but closes the hole. Same for the closing angle bracket
  // and ampersand, which matter if this is ever moved into an attribute.
  const safe = payload
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return `(function(){try{var c=${safe};
for(var k in c){ if(localStorage.getItem(k)!==c[k]) localStorage.setItem(k,c[k]); }
}catch(e){/* private mode: the store falls back to its own setup terminal */}})();`;
}
