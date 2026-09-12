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
 * shape the store reads at boot — with one hard rule the IP leak taught: the
 * browser is told `/plex`, a path on the origin it is already on, and NEVER
 * one of Plex's own advertised addresses. Those encode the operator's public
 * IP (https://115-70-96-154.<hash>.plex.direct:32400), and handing one out
 * published it to every viewer's localStorage while routing all media traffic
 * around the tunnel. The front door proxies /plex to the real address
 * (plex-proxy.ts); the browser never learns it.
 *
 * ON HANDING THE BROWSER A PLEX TOKEN: it is that viewer's OWN per-server
 * token, delivered over their authenticated session. The store appends it to
 * its Plex requests, and Plex's own web client works exactly this way. It is
 * deliberately inert on its own: it authenticates against ONE server, and the
 * only route to that server is the session-gated proxy. What is NOT done is
 * handing anyone the owner's token, or a token for a server they were not
 * admitted to: the connection is resolved from the requester's own
 * credentials every time.
 */

import type { PlexClientIdentity } from './plex-client.ts';
import { fetchResources } from './plex-client.ts';
import { PLEX_PROXY_BASE } from './plex-proxy.ts';

export interface StoreConnection {
  /** Base URL the BROWSER is given — always this front door's own /plex path.
   *  The real address never reaches a page: it would sit in localStorage
   *  forever and carry every artwork and video request past the tunnel. */
  url: string;
  /** The address the FRONT DOOR proxies /plex to, resolved from the viewer's
   *  own token. Server-side only. */
  upstream: string;
  /** Every origin Plex advertises for this server, so absolute URLs in
   *  proxied playlists and documents can be rewritten to the proxy base. */
  origins: string[];
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

/** Scheme + host + port of a connection URI, or null when it has none.
 *
 *  BOTH spellings are returned when they differ. `new URL` erases a default
 *  port outright — `https://host:443` parses to origin `https://host` — but a
 *  playlist quoting the address Plex advertised may still write `:443`
 *  explicitly, and a rewrite set missing one spelling is the rewrite that
 *  leaks. */
function originsOf(uri: string): string[] {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(String(uri || ''));
  if (!match) return [];
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return [];
  const withPort = `${scheme}://${match[2]}`;
  let origin: string;
  try {
    origin = new URL(withPort).origin;
  } catch {
    return [];
  }
  return origin === withPort ? [origin] : [origin, withPort];
}

export interface UpstreamChoice {
  uri: string;
  origins: string[];
}

/**
 * Choose which of a server's advertised addresses the FRONT DOOR proxies to,
 * and collect every advertised origin for the rewrite set.
 *
 * The constraints are the browser's turned inside out. When the store talked
 * to Plex directly, the choice had to survive mixed-content rules and dead
 * LAN addresses, so remote HTTPS won. Now the front door — which shares the
 * Plex server's own network — makes the requests, so the order flips:
 *
 *  - A LAN address is fastest and never leaves the home network. From the
 *    browser it was useless across town; from here it is the best option,
 *    and it also avoids NAT hairpin, where a machine inside the network
 *    reaches its own public address through the router — which some
 *    consumer routers simply do not do.
 *  - A plex.direct HTTPS address works from anywhere and carries a real
 *    certificate, which still matters for a LAN-unreachable deployment (the
 *    container on a different subnet, Plex behind a VLAN).
 *  - A relay address works when nothing else does, but Plex rate-limits and
 *    bandwidth-caps it, so it stays a last resort.
 *
 * `origins` is EVERY advertised address, not just the chosen one: a playlist
 * may name any address the server advertises, and the rewrite set that misses
 * one is the rewrite that leaks.
 */
export function pickUpstream(
  connections: readonly PlexConnectionEntry[] | null | undefined,
): UpstreamChoice | null {
  if (!Array.isArray(connections) || connections.length === 0) return null;
  const usable = connections.filter((c) => c && typeof c.uri === 'string'
    && /^https?:\/\//i.test(c.uri));
  if (!usable.length) return null;

  const origins = [...new Set(usable.flatMap((c) => originsOf(c.uri)))];

  const local = usable.find((c) => c.local);
  if (local) return { uri: local.uri, origins };

  const https = usable.filter((c) => c.protocol === 'https' && !c.relay);
  if (https.length) return { uri: https[0].uri, origins };

  const plain = usable.filter((c) => c.protocol !== 'https' && !c.relay);
  if (plain.length) return { uri: plain[0].uri, origins };

  const relay = usable.find((c) => c.relay);
  if (relay) return { uri: relay.uri, origins };

  return { uri: usable[0].uri, origins };
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
  // plex.tv unreachable: no connection this request (a read path — callers
  // already handle null as "no connection"), never a wrong one.
  if (!resources) return null;

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

  const pick = pickUpstream(server.connections || []);
  // The per-resource accessToken, not the account token: it is scoped to this
  // one server, so a leak from the browser cannot reach the viewer's other
  // servers or their Plex account.
  const token = server.accessToken || viewerToken;
  if (!pick) return null;

  return {
    // The browser gets the proxy path and nothing else. With the real
    // address in localStorage, every viewer held the operator's public IP
    // permanently, and every byte of artwork and video bypassed the tunnel.
    url: PLEX_PROXY_BASE,
    upstream: pick.uri,
    origins: pick.origins,
    token,
    machineId,
    name: server.name || 'Plex',
  };
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
export function connectionBootstrapScript(
  conn: StoreConnection,
  userId: string,
  /**
   * Owner policy as the store's own settings keys — which libraries it carries,
   * whether the games department exists. Applied on every load so it is policy
   * rather than a default a viewer can drift away from.
   */
  policy: Record<string, string> = {},
): string {
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
    // Tells the store it is being served through the front door, so it offers a
    // viewer's menu rather than an owner's: controls, sign out, back to the
    // store. Everything administrative moved to the management console, and the
    // public port is reachable by everyone a library was shared with.
    bb_viewer_only: '1',
    // Policy last so it cannot be shadowed by a connection key sharing a name.
    ...policy,
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
