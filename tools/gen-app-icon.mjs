#!/usr/bin/env node
/**
 * Render deploy/icon/volkbuster-icon.svg to the PNG and ICO sizes a NAS
 * dashboard and a browser tab actually ask for.
 *
 * WHY RENDER RATHER THAN SHIP THE SVG: ZimaOS/CasaOS tiles want a raster URL,
 * and Windows/Explorer still wants a real .ico. Both are derived here from the
 * one SVG so the icon cannot drift from the mark — the same reason the cover
 * thumbnails are generated from the app's own painters rather than drawn twice.
 *
 * Uses the bundled Archivo Black, self-hosted like everywhere else in this
 * project: a fetch to Google Fonts would leak a request on every render, and
 * the whole point of the `textLength` in the SVG is that it degrades cleanly if
 * the face is missing anyway.
 *
 *   node tools/gen-app-icon.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = new URL('..', import.meta.url);
const SVG = readFileSync(new URL('deploy/icon/volkbuster-icon.svg', ROOT), 'utf8');
const FONT = readFileSync(new URL('src/assets/archivo-black.ttf', ROOT)).toString('base64');
const OUT = new URL('deploy/icon/', ROOT);

/** PNG sizes: 512 for stores, 256 for tiles, 64/32/16 for the ICO. */
const PNG_SIZES = [512, 256, 128, 64, 32, 16];

const page_html = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Archivo Black'; src:url(data:font/ttf;base64,${FONT}) format('truetype'); font-weight:400; }
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${SVG}</body></html>`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  mkdirSync(fileURLToPath(OUT), { recursive: true });
  const pngs = new Map();

  for (const size of PNG_SIZES) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(page_html(size), { waitUntil: 'load' });
    // The face is embedded as a data URI, but layout still has to settle before
    // the capture or the text renders in a fallback and the textLength scaling
    // is computed against the wrong metrics.
    await page.evaluate(() => document.fonts.ready);
    const buf = await page.screenshot({ omitBackground: true, type: 'png' });
    pngs.set(size, Buffer.from(buf));
    if (size === 512 || size === 256) {
      const name = `volkbuster-icon-${size}.png`;
      writeFileSync(new URL(name, OUT), buf);
      console.log(`  wrote ${name}  ${(buf.length / 1024).toFixed(1)}KB`);
    }
  }

  // ICO container, written by hand: it is a 6-byte header, a 16-byte directory
  // entry per image, then the PNG payloads. Every modern consumer accepts PNG
  // inside ICO, so there is no BMP encoding to do and no dependency to add.
  const icoSizes = [64, 32, 16];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(icoSizes.length, 4);

  let offset = 6 + icoSizes.length * 16;
  const entries = [];
  const payloads = [];
  for (const size of icoSizes) {
    const png = pngs.get(size);
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256 in the ICO format
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);                       // palette count
    e.writeUInt8(0, 3);                       // reserved
    e.writeUInt16LE(1, 4);                    // colour planes
    e.writeUInt16LE(32, 6);                   // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
    payloads.push(png);
  }
  const ico = Buffer.concat([header, ...entries, ...payloads]);
  writeFileSync(new URL('volkbuster.ico', OUT), ico);
  console.log(`  wrote volkbuster.ico  ${(ico.length / 1024).toFixed(1)}KB  (${icoSizes.join('/')}px)`);
} finally {
  await browser.close();
}
