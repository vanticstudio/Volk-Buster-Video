#!/usr/bin/env node
/**
 * Regenerate the four `bb_cover_*` settings-drawer thumbnails from the CURRENT
 * brand.
 *
 * WHY THIS EXISTS: the settings drawer previews each cover style with a 480x270
 * PNG in public/setting-thumbs/, and those previews are box wraps carrying the
 * house wordmark. Upstream shipped them rendered from its own brand, so after a
 * rebrand the drawer still advertises the old one — four little pictures of
 * somebody else's store, inside your store. Upstream's generator
 * (tools/gen_setting_thumbs.mjs) is not present in this checkout, so this
 * replaces it for the covers that actually show the brand. The other 33 thumbs
 * are interior and storefront shots with no legible wordmark and do not need
 * regenerating on a rebrand.
 *
 * HOW: `vite dev` serves tools/thumb-harness.html, which imports the real wrap
 * painters (src/logo-wrap.ts) and renders each variant against the live
 * LogoSpec. Puppeteer reads the resulting data URLs. Rendering through the
 * app's own painters rather than reimplementing them is the point: the
 * thumbnail cannot drift from what the store actually prints.
 *
 *   node tools/gen-cover-thumbs.mjs
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer';

const PORT = 5199;
const OUT_DIR = new URL('../public/setting-thumbs/', import.meta.url);

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`vite dev did not come up on ${url}`);
}

const vite = spawn(
  'npx',
  ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: ['ignore', 'pipe', 'pipe'], cwd: new URL('..', import.meta.url) },
);
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

let browser;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/tools/thumb-harness.html`);

  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/tools/thumb-harness.html`, { waitUntil: 'networkidle0' });
  // The harness sets document.title when it finishes; polling that is simpler
  // and more honest than a fixed sleep, which would silently truncate a slow
  // font load and bake fallback glyphs into the PNGs.
  await page.waitForFunction(
    () => document.title === 'ready' || document.title === 'error',
    { timeout: 60_000 },
  );

  const err = await page.evaluate(() => window.__thumbError);
  if (err) throw new Error(`harness failed: ${err}`);

  const thumbs = await page.evaluate(() => window.__thumbs);
  let n = 0;
  for (const [name, dataUrl] of Object.entries(thumbs)) {
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    const path = new URL(`${name}.png`, OUT_DIR);
    writeFileSync(path, png);
    console.log(`  wrote ${name}.png  ${(png.length / 1024).toFixed(1)}KB`);
    n++;
  }
  console.log(`\n${n} cover thumbnails regenerated from the current brand.`);
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
