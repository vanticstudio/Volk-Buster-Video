/**
 * The front door's private pipe from a viewer's browser to their Plex server.
 *
 * WHY THIS EXISTS — AND WHAT IT REMOVES FROM THE PAGE
 *
 * The connection the store is handed used to be one of Plex's own advertised
 * addresses, which for a remote viewer is `https://115-70-96-154.<hash>.
 * plex.direct:32400` — the operator's public IP, encoded in the hostname, in
 * every viewer's localStorage, and carrying every byte of artwork and video
 * direct to the home WAN, around the Cloudflare tunnel entirely. Any viewer
 * could read the address out of devtools at any time, not just at sign-in.
 *
 * The store is instead handed `/plex` — a path on the origin it is already
 * talking to — and every Plex request a browser makes goes through here: the
 * session gate has already run (this module is never reachable without one),
 * the upstream address is resolved server-side from the viewer's own token,
 * and the request forwards with only a path. A browser never learns where the
 * Plex server actually lives, and a stolen per-server token is inert without
 * it: the only door that token works through is this one, and this one
 * demands a session.
 *
 * WHAT IT IS NOT: a filter on paths or methods. Plex's own authorisation
 * still governs — the forwarded request carries the viewer's per-server
 * token, and a shared-library token reaches exactly what the owner shared.
 * This pipe adds no second authorisation model to keep in sync; it only makes
 * the address invisible and the route session-gated.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** The only address of the Plex server a browser is ever given. */
export const PLEX_PROXY_BASE = '/plex';

/**
 * Hop-by-hop headers, which belong to a single connection and must never be
 * forwarded (RFC 9110 §7.6.1) — the same set app-proxy.ts drops.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Request headers that describe the proxy chain or carry our session, and so
 * stop here. The session cookie is this server's credential and Plex has no
 * use for it; the forwarded headers would tell Plex about Cloudflare and the
 * viewer, which is nobody's business but ours.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
]);

function sanitise(headers: NodeJS.Dict<string | string[]>): NodeJS.Dict<string | string[]> {
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (DROPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The path + query to forward upstream, with the `/plex` base stripped.
 *
 * Null when this request is not under the proxy base at all. `new URL`
 * normalises dot segments, so `/plex/../api/config` arrives here as
 * `/api/config` — outside the base — and is refused rather than smuggled
 * through as a Plex path.
 */
export function plexProxyTarget(req: IncomingMessage): string | null {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  if (p !== PLEX_PROXY_BASE && !p.startsWith(`${PLEX_PROXY_BASE}/`)) return null;
  return (p === PLEX_PROXY_BASE ? '/' : p.slice(PLEX_PROXY_BASE.length)) + url.search;
}

/**
 * Rewrite every address Plex advertises for this server out of a body or
 * header, replacing it with the same-origin proxy base.
 *
 * Playlists are the reason this must exist: Plex's HLS responses can carry
 * absolute segment URLs on the server's own advertised origin, and a playlist
 * that slipped a plex.direct hostname past the bootstrap would put the
 * operator's IP back in the browser by the side door. Split-and-join rather
 * than a regex so an address full of dots and dashes is matched literally.
 */
export function rewriteUpstreamOrigins(text: string, origins: readonly string[]): string {
  let out = text;
  for (const origin of origins) {
    if (origin) out = out.split(origin).join(PLEX_PROXY_BASE);
  }
  return out;
}

/** Body types small enough to buffer, and worth rewriting. */
const REWRITE_TYPES = /mpegurl|dash\+xml|xml|text\/html/i;
/** Ceiling on a buffered rewrite. A playlist is kilobytes; a body that claims
 *  or grows past this is not one, and rewriting it is not worth the memory. */
const REWRITE_CAP_BYTES = 8 * 1024 * 1024;

export interface PlexProxyOptions {
  /** The server address resolved from the viewer's own token. Browser-blind. */
  upstream: string;
  /** Every origin advertised for that server — the rewrite set. */
  origins: readonly string[];
}

/**
 * Forward one already-authenticated request to the viewer's Plex server and
 * stream the reply back.
 *
 * Streams everything except the small text bodies that may name the upstream
 * address. Streaming is load-bearing: this pipe carries video, and buffering
 * a movie segment would put a per-viewer memory ceiling on the whole service.
 */
export function proxyPlex(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PlexProxyOptions,
): void {
  const suffix = plexProxyTarget(req);
  if (suffix === null) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not a Plex proxy path' }));
    return;
  }

  let base: URL;
  try {
    base = new URL(opts.upstream);
  } catch {
    // An unresolvable connection is a resolver bug, not a viewer error; the
    // message must not name the malformed address either.
    console.error('[front-door] plex proxy: unresolvable upstream connection');
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Plex is not reachable right now — try again in a moment.' }));
    return;
  }

  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  // A connection URI is origin-shaped, but honour a base path if one ever
  // appears rather than silently dropping it.
  const prefix = base.pathname.replace(/\/+$/, '');

  const upstream = send(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path: prefix + suffix,
      headers: {
        ...sanitise(req.headers),
        host: base.host,
      },
    },
    (upRes) => {
      const headers = sanitise(upRes.headers);
      const type = String(upRes.headers['content-type'] || '');

      // A redirect to one of the server's own addresses is followed by the
      // browser, so it must leave pointing at the proxy. A redirect anywhere
      // else is left alone — rewriting a host we did not resolve would be a
      // guess about someone else's infrastructure.
      const location = headers['location'];
      if (typeof location === 'string' && location) {
        headers['location'] = rewriteUpstreamOrigins(location, opts.origins);
      }

      const declared = Number(headers['content-length']);
      const rewrite = REWRITE_TYPES.test(type) && !(Number.isFinite(declared) && declared > REWRITE_CAP_BYTES);
      if (!rewrite) {
        res.writeHead(upRes.statusCode || 502, headers);
        upRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let overflow = false;
      upRes.on('data', (c: Buffer) => {
        total += c.length;
        if (total > REWRITE_CAP_BYTES) overflow = true;
        else chunks.push(c);
      });
      upRes.on('end', () => {
        if (overflow) {
          // Unreachable in practice — no real playlist or XML document is
          // megabytes — and failing loudly beats rewriting half a body or
          // holding an unbounded buffer.
          console.error('[front-door] plex proxy: rewritable body exceeded the cap');
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ error: 'Plex sent a body too large to proxy.' }));
          return;
        }
        const body = rewriteUpstreamOrigins(Buffer.concat(chunks).toString('utf8'), opts.origins);
        // The body changed length; a stale content-length truncates it.
        delete headers['content-length'];
        headers['content-length'] = String(Buffer.byteLength(body));
        res.writeHead(upRes.statusCode || 502, headers);
        res.end(body);
      });
    },
  );

  upstream.on('error', (err) => {
    // Plex being down is an operational fault, not the viewer's problem, and
    // the message must not leak the address the connection failed on.
    console.error('[front-door] plex proxy: upstream unreachable:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Plex is not reachable right now — try again in a moment.' }));
  });

  // A viewer navigating away mid-segment must not leave the upstream request
  // hanging: without this the pipe leaks a socket per abandoned request, and
  // a store page pulls hundreds.
  res.on('close', () => upstream.destroy());

  req.pipe(upstream);
}
