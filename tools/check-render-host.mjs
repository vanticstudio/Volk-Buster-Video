#!/usr/bin/env node
/**
 * Can this machine render the store server-side, and how many at once?
 *
 * Run this ON THE HOST (or inside the container) before anything is built
 * around a guess. The design doc's §9 R1 says the VRAM question must be
 * "measured before the pool is built around it"; this is that measurement,
 * plus the one that actually decides whether the idea works at all:
 *
 *   DOES HEADLESS CHROMIUM GET THE REAL GPU, OR SWIFTSHADER?
 *
 * That distinction is invisible from the outside and fatal. A software-rendered
 * store boots, streams, and looks almost right — at about two frames a second,
 * with one CPU core pinned per viewer. Chromium will fall back silently: no
 * error, no warning, just a store nobody can walk around in. The only honest
 * test is to make a WebGL2 context and read the renderer string back, which is
 * what this does.
 *
 *   node tools/check-render-host.mjs
 *   node tools/check-render-host.mjs --titles 2174    # size the VRAM maths
 *
 * Exits non-zero if server-side rendering would not work here, so it can gate
 * a deployment rather than just inform one.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const titles = Number(args[args.indexOf('--titles') + 1]) || 2174;

const ok = (s) => `  ✓ ${s}`;
const no = (s) => `  ✗ ${s}`;
const hm = (s) => `  ? ${s}`;
const MB = 1024 * 1024;

let fatal = 0;

function section(t) { console.log(`\n${t}\n${'─'.repeat(t.length)}`); }

// ── 1. Is there a GPU to talk to at all? ────────────────────────────────────
section('GPU devices');
let dri = [];
try {
  dri = readdirSync('/dev/dri');
} catch {
  // Not Linux, or no devices mapped into the container.
}
const render = dri.filter((d) => d.startsWith('render'));
const cards = dri.filter((d) => d.startsWith('card'));
if (render.length || cards.length) {
  console.log(ok(`/dev/dri: ${dri.join(', ')}`));
} else if (process.platform !== 'linux') {
  console.log(hm(`${process.platform} — no /dev/dri here; Chrome picks its own backend (Metal/D3D).`));
} else {
  console.log(no('/dev/dri is empty or absent.'));
  console.log('      In Docker this needs:  --device /dev/dri');
  console.log('      Without it, every instance renders in software.');
  fatal++;
}

// Name the card, so "I have an Arc" is verified rather than assumed.
for (const path of ['/sys/class/drm/card0/device/vendor', '/sys/class/drm/card1/device/vendor']) {
  if (!existsSync(path)) continue;
  try {
    const vendor = readFileSync(path, 'utf8').trim();
    const dev = readFileSync(path.replace('/vendor', '/device'), 'utf8').trim();
    const who = vendor === '0x8086' ? 'Intel' : vendor === '0x1002' ? 'AMD' : vendor === '0x10de' ? 'NVIDIA' : vendor;
    console.log(ok(`${path.split('/')[4]}: ${who} (vendor ${vendor}, device ${dev})`));
  } catch { /* unreadable — not fatal, the WebGL probe below is what counts */ }
}

// ── 2. The one that matters: hardware WebGL, or silent SwiftShader? ─────────
section('Headless WebGL');
let rendererString = null;
try {
  const puppeteer = (await import('puppeteer')).default;
  const glArgs = (render.length || cards.length)
    ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl-egl']
    : [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...glArgs],
  });
  try {
    const page = await browser.newPage();
    const probe = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false, why: 'no WebGL2 context at all' };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      };
    });
    if (!probe.ok) {
      console.log(no(probe.why));
      fatal++;
    } else {
      rendererString = String(probe.renderer || '');
      const soft = /swiftshader|llvmpipe|software|swarm/i.test(rendererString);
      console.log((soft ? no : ok)(`renderer: ${rendererString}`));
      console.log(`      vendor: ${probe.vendor}`);
      if (soft) {
        console.log('      THIS IS SOFTWARE RENDERING. The store will boot and stream at a');
        console.log('      few frames per second with a CPU core pinned per viewer. Server-');
        console.log('      side rendering is not viable until this line names the real GPU.');
        fatal++;
      }
      // The poster bank is a DataArrayTexture; this caps the catalog.
      console.log(ok(`MAX_ARRAY_TEXTURE_LAYERS: ${probe.maxArrayLayers} (one layer per title)`));
      if (probe.maxArrayLayers < titles) {
        console.log(`      Below the ${titles}-title catalog — titles past this get no cover art.`);
      }
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  console.log(no(`could not launch Chromium: ${String(e.message).slice(0, 160)}`));
  fatal++;
}

// ── 3. What one instance costs, and therefore how many fit ─────────────────
section(`VRAM budget (${titles} titles)`);
// Straight from src/poster-textures.ts: a 160x240 RGBA mipped high-res bank,
// one layer per title, plus a 512x768 low-res atlas packing 64 tiles a layer.
const hi = 160 * 240 * 4 * titles * (4 / 3);
const lowLayers = Math.ceil(titles / 64);
const low = 512 * 768 * 4 * lowLayers;
const posters = hi + low;
// Everything else a live instance holds: scene geometry, materials, env probes,
// render targets, and Chromium's own GPU-process overhead. Not measured here —
// stated as the assumption it is, so the arithmetic can be checked.
const OTHER_PER_INSTANCE = 400 * MB;
const per = posters + OTHER_PER_INSTANCE;
console.log(`  posters:        ${(posters / MB).toFixed(0)} MB   (high-res ${(hi / MB).toFixed(0)} + atlas ${(low / MB).toFixed(0)})`);
console.log(`  scene + chrome: ${(OTHER_PER_INSTANCE / MB).toFixed(0)} MB   [ASSUMED — measure with intel_gpu_top]`);
console.log(`  per instance:   ${(per / MB).toFixed(0)} MB`);
for (const [card, vram] of [['Arc A310', 6], ['8 GB card', 8], ['12 GB card', 12]]) {
  // Plex transcoding shares this card; leaving it nothing is how you get
  // stuttering playback for everyone the moment someone starts a film.
  const forPlex = 1.5;
  const usable = vram - forPlex;
  const n = Math.floor((usable * 1024 * MB) / per);
  console.log(`  ${card.padEnd(10)} ${vram} GB - ${forPlex} GB reserved for Plex = ${usable} GB  →  ${n} concurrent instance(s)`);
}

// ── 4. Media engine: can it encode the streams? ────────────────────────────
section('Hardware video encode');
try {
  const out = execSync('which vainfo && vainfo 2>/dev/null', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const enc = [...out.matchAll(/VAProfile(\w+).*VAEntrypointEncSlice/g)].map((m) => m[1]);
  if (enc.length) console.log(ok(`encode profiles: ${[...new Set(enc)].join(', ')}`));
  else console.log(hm('vainfo ran but reported no encode entrypoints.'));
} catch {
  console.log(hm('vainfo not available — install vainfo (intel-media-va-driver) to confirm encode.'));
  console.log('      WebRTC will still encode in software if this is missing, which');
  console.log('      costs CPU per stream and is the second thing to verify.');
}

// ── Verdict ────────────────────────────────────────────────────────────────
section('Verdict');
if (fatal) {
  console.log(no(`${fatal} blocker(s). Server-side rendering will not work here yet.`));
  console.log('  Fix the ✗ lines above and re-run.');
  process.exit(1);
}
console.log(ok('This host can render the store server-side.'));
console.log('  Next: measure one REAL instance with intel_gpu_top while it runs,');
console.log('  and replace the assumed 400 MB above with what it actually costs.');
