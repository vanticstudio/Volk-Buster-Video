/**
 * Reverse proxy from the front door to the store app.
 *
 * WHY THIS EXISTS: the front door and the store are two processes. The front
 * door owns the public port and decides who gets in; the store is `vite
 * preview` bound to loopback. Without something joining them, a signed-in
 * viewer reaches an authenticated dead end and the only way to actually see the
 * store is to expose Vite directly — which is a media library on the open
 * internet with no gate at all.
 *
 * So this is not a convenience. It is the piece that makes the gate mean
 * anything: every byte of the store now arrives through a request that already
 * carried a valid session.
 *
 * WHAT IT IS NOT: the instance pool. This proxies ONE shared store to every
 * viewer — everybody drives the same camera, and it is rendered by the viewer's
 * own browser rather than the host GPU. That is a useful thing to run and test
 * today, and it is not the design in
 * docs/architecture/2026-09-06-plex-only-streaming-fork.md. Per-user instances
 * replace this.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';

/**
 * Hop-by-hop headers, which belong to a single connection and must never be
 * forwarded (RFC 9110 §7.6.1). Passing `connection` or `transfer-encoding`
 * through a proxy corrupts framing in ways that surface as truncated assets.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function sanitise(headers: NodeJS.Dict<string | string[]>): NodeJS.Dict<string | string[]> {
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    // The session cookie is ours and stops here. The store has no use for it,
    // and forwarding a credential past the boundary that checked it is how a
    // downstream log ends up holding one.
    if (k.toLowerCase() === 'cookie') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Forward one already-authenticated request to the store and stream the reply
 * back.
 *
 * Streams rather than buffers: the store serves 100MB+ of textures, models and
 * HDR skies, and buffering those into the front door's memory would put a
 * per-request ceiling on how many viewers it can serve at once.
 */
export function proxyToApp(
  req: IncomingMessage,
  res: ServerResponse,
  appOrigin: string,
  /**
   * Inline JS to run before the app's own module script.
   *
   * This is how a viewer arrives at a store that is already connected to Plex
   * instead of the "pick a distributor" terminal. It must be INLINE and it must
   * be injected into the HTML rather than fetched: the app reads its connection
   * out of localStorage synchronously at module-evaluation time, so anything
   * asynchronous lands after the store has already decided it is unconfigured.
   */
  bootstrap?: string,
): void {
  const target = new URL(req.url || '/', appOrigin);

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.pathname + target.search,
      headers: {
        ...sanitise(req.headers),
        host: target.host,
        // When we are going to REWRITE the document, ask upstream not to
        // compress it.
        //
        // vite preview gzips HTML whenever the client asks for it. Buffering
        // those bytes and calling .toString('utf8') on them does not "fail" —
        // it silently replaces every invalid sequence with U+FFFD, so the
        // marker search finds nothing, the body is quietly destroyed, and it
        // still goes out under a Content-Encoding: gzip header. The browser
        // then tries to gunzip mush and renders nothing at all.
        //
        // Only document requests reach this branch (bootstrap is computed for
        // Accept: text/html), so assets keep their compression.
        ...(bootstrap ? { 'accept-encoding': 'identity' } : {}),
      },
    },
    (upRes) => {
      const type = String(upRes.headers['content-type'] || '');
      const isHtml = type.includes('text/html');
      // Belt and braces: if something upstream compressed anyway, pass it
      // through untouched rather than corrupting it. Losing the injection means
      // the viewer meets the store's own setup terminal — a worse experience,
      // and a recoverable one. Corrupting the document is a blank page.
      const encoded = Boolean(upRes.headers['content-encoding']);

      // Everything that is not the document streams straight through. The store
      // serves 100MB+ of textures, models and HDR skies, and buffering those to
      // rewrite them would put a per-request memory ceiling on how many viewers
      // this can serve at once. Only the HTML is small enough to hold.
      if (!bootstrap || !isHtml || encoded) {
        res.writeHead(upRes.statusCode || 502, sanitise(upRes.headers));
        upRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upRes.on('data', (c: Buffer) => chunks.push(c));
      upRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        const tag = `<script>${bootstrap}</script>`;
        // After <head> so it runs before any module script the document loads.
        // If the marker is missing the document is not what we think it is, so
        // pass it through untouched rather than guessing where to splice.
        const at = body.indexOf('<head>');
        if (at >= 0) body = body.slice(0, at + 6) + tag + body.slice(at + 6);

        const headers = sanitise(upRes.headers);
        // The body changed length; a stale content-length truncates the page.
        delete headers['content-length'];
        headers['content-length'] = String(Buffer.byteLength(body));
        // It now carries a per-viewer token, so it must never be cached by a
        // proxy or served to a second person.
        headers['cache-control'] = 'private, no-store';
        res.writeHead(upRes.statusCode || 502, headers);
        res.end(body);
      });
    },
  );

  upstream.on('error', (err) => {
    // The store being down is an operational fault, not the viewer's problem,
    // and the message must not leak the internal address.
    console.error('[front-door] store unreachable:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('The store is not running. Check the app process on this host.');
  });

  // A viewer navigating away mid-download must not leave the upstream request
  // hanging: without this the front door leaks a socket per abandoned load, and
  // a store page pulls hundreds of assets.
  res.on('close', () => upstream.destroy());

  req.pipe(upstream);
}
