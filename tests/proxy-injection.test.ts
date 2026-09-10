// The proxy rewriting the document, against a real upstream that compresses.
//
// This file exists because of a bug that made the store unusable exactly when
// it started working: once a viewer was signed in AND the store was configured,
// the proxy began injecting the Plex connection into the HTML — and vite
// preview serves that HTML gzipped whenever the client asks for it.
//
// Buffering gzip bytes and calling .toString('utf8') does not throw. It
// silently replaces every invalid byte sequence with U+FFFD, so the marker
// search finds nothing, the body is destroyed, and it still goes out under a
// Content-Encoding: gzip header. The browser gunzips mush and renders nothing.
//
// A test that only asserted "the script tag is present" would have passed on an
// uncompressed fixture and missed all of it. These use a real gzip-capable
// upstream instead.
//
//   npm run test:proxyinject

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { proxyToApp } from '../server/app-proxy.ts';

const HTML = '<!doctype html><html><head><title>Store</title></head><body>shelves</body></html>';
const BOOTSTRAP = "localStorage.setItem('jellyfin_url','https://s.plex.direct:32400');";

let upstream: Server;
let proxy: Server;
let upstreamOrigin: string;
let proxyBase: string;
/** Set per test: does the upstream honour Accept-Encoding? */
let compress = true;

before(async () => {
  // Stands in for `vite preview`, including its gzip behaviour.
  upstream = createServer((req, res) => {
    const wants = String(req.headers['accept-encoding'] || '').includes('gzip');
    if (req.url?.startsWith('/asset')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('export const x = 1;');
      return;
    }
    if (compress && wants) {
      const body = gzipSync(Buffer.from(HTML));
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(HTML)) });
    res.end(HTML);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  proxy = createServer((req, res) => {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    proxyToApp(req, res, upstreamOrigin, wantsHtml ? BOOTSTRAP : undefined);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

test('a browser asking for gzip still gets a readable, injected document', async () => {
  // The exact failing case: a real browser always sends Accept-Encoding: gzip.
  compress = true;
  const res = await fetch(`${proxyBase}/`, {
    headers: { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br' },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Store<\/title>/, 'the document must survive intact');
  assert.match(body, /localStorage\.setItem/, 'the connection must be injected');
  assert.doesNotMatch(body, /�/, 'no replacement characters — that is corrupted binary');
});

test('the injected script runs before the document body', async () => {
  // The app reads its connection synchronously at module-evaluation time, so
  // landing after the body would be too late.
  compress = true;
  const body = await (await fetch(`${proxyBase}/`, { headers: { accept: 'text/html' } })).text();
  assert.ok(body.indexOf('localStorage.setItem') < body.indexOf('<body>'), 'must precede <body>');
});

test('content-length matches the rewritten body', async () => {
  // A stale length from the upstream response truncates the page mid-tag.
  compress = true;
  const res = await fetch(`${proxyBase}/`, { headers: { accept: 'text/html' } });
  const declared = Number(res.headers.get('content-length'));
  const actual = Buffer.byteLength(await res.text());
  assert.equal(declared, actual);
});

test('a rewritten document is never cached', async () => {
  // It now carries a per-viewer Plex token. A shared cache holding it would
  // hand one viewer another viewer's credentials.
  compress = true;
  const res = await fetch(`${proxyBase}/`, { headers: { accept: 'text/html' } });
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('an uncompressed upstream is handled identically', async () => {
  compress = false;
  const body = await (await fetch(`${proxyBase}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(body, /<title>Store<\/title>/);
  assert.match(body, /localStorage\.setItem/);
});

test('assets stream through untouched and keep their compression', async () => {
  // Only the document is buffered. The store serves 100MB+ of textures and
  // models; buffering those would cap how many viewers this can serve at once.
  compress = true;
  const res = await fetch(`${proxyBase}/asset/main.js`, { headers: { accept: '*/*' } });
  const body = await res.text();
  assert.equal(body, 'export const x = 1;');
  assert.doesNotMatch(body, /localStorage/, 'assets must not be rewritten');
});
