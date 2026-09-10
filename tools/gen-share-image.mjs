#!/usr/bin/env node
/**
 * Render deploy/icon/volkbuster-share.svg to the PNG that link unfurlers show.
 *
 * WHY A RASTER AT ALL: no unfurler renders SVG. Discord, Slack, iMessage,
 * WhatsApp, Signal and Twitter all fetch the og:image URL and expect a PNG or
 * JPEG; hand one an SVG and the card falls back to a bare link. So the mark is
 * authored once as vector and rasterised here, exactly like the app icon.
 *
 * WHY 1200x630: the 1.91:1 box every one of them crops to. Supplying it at
 * that ratio is the only way to control what gets cut.
 *
 * The output goes into public/, so it is served by the store app AND copied
 * into the container image — the front door reads it from there to serve the
 * card unauthenticated (server/index.ts). A crawler has no Plex session and
 * never will, so an og:image behind the gate is an og:image nobody sees.
 *
 * Uses the bundled Archivo Black, self-hosted like everywhere else here: a
 * fetch to Google Fonts would leak a request on every render, and the SVG's
 * textLength degrades cleanly if the face is missing anyway.
 *
 *   node tools/gen-share-image.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = new URL('..', import.meta.url);
const SVG = readFileSync(new URL('deploy/icon/volkbuster-share.svg', ROOT), 'utf8');
const FONT = readFileSync(new URL('src/assets/archivo-black.ttf', ROOT)).toString('base64');
const OUT = new URL('public/share/', ROOT);

const W = 1200;
const H = 630;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Archivo Black'; src:url(data:font/ttf;base64,${FONT}) format('truetype'); font-weight:400; }
  html,body{margin:0;padding:0;background:#0d1018}
  svg{display:block;width:${W}px;height:${H}px}
</style></head><body>${SVG}</body></html>`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  // deviceScaleFactor 1: the card is authored at its final pixel size, and
  // unfurlers downscale rather than up. A 2x render would only be a bigger
  // file for the same displayed result, and several of them cap at ~1MB
  // before they give up and show a bare link.
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  // The face is a data URI, but layout still has to settle before the capture
  // or the text renders in a fallback and textLength scales against the wrong
  // metrics — the same trap gen-app-icon.mjs documents.
  await page.evaluate(() => document.fonts.ready);

  // omitBackground:false on purpose. A transparent PNG composites against
  // whatever the chat client's own background is, and half of them are light —
  // cream text on white is an invisible card.
  const buf = await page.screenshot({ type: 'png', omitBackground: false });

  mkdirSync(fileURLToPath(OUT), { recursive: true });
  writeFileSync(new URL('volkbuster-share.png', OUT), buf);
  console.log(`  wrote public/share/volkbuster-share.png  ${W}x${H}  ${(buf.length / 1024).toFixed(1)}KB`);
} finally {
  await browser.close();
}
