// Throwaway: measure real frame rate on THIS machine while changing sections.
// No --use-gl flag, so on macOS Chromium picks ANGLE/Metal on the real M4 Pro
// (the SwiftShader flag is what made the earlier headless attempt stall).
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';

const PORT = 4191;
const vite = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const out = {};
try {
  const page = await browser.newPage();
  // A MacBook Pro 14 window at Retina scale — calibration and supersample
  // budgets are derived from exactly these two numbers.
  await page.setViewport({ width: 1512, height: 900, deviceScaleFactor: 2 });
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (/calibrate|GPU\]|AO\]|quality|supersample/i.test(t)) logs.push(t); });
  await page.goto(`http://127.0.0.1:${PORT}/?demo=1`, { waitUntil: 'domcontentloaded' });

  // Wait for a live scene that has actually rendered frames.
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 420_000) {
    ready = await page.evaluate(() => {
      const s = window.storeScene;
      return !!(s && s.getPerfInfo && s.getPerfInfo().frames > 30 && !document.querySelector('#boot-overlay.visible, .boot-overlay.visible'));
    }).catch(() => false);
    if (ready) break;
    await sleep(2000);
  }
  out.bootSeconds = Math.round((Date.now() - t0) / 1000);
  out.ready = ready;
  if (!ready) throw new Error('store never became ready inside the timeout');
  await sleep(5000); // let boot-time texture streaming settle before measuring

  out.calibration = await page.evaluate(() => ({
    bb_quality_auto: localStorage.getItem('bb_quality_auto'),
    bb_quality_ss: localStorage.getItem('bb_quality_ss'),
    bb_fps_cap: localStorage.getItem('bb_fps_cap'),
    perf: window.storeScene.getPerfInfo(),
  }));

  // In-page rAF sampler: counts PRESENTED frames, independent of the app.
  const measure = async (label, driver) => page.evaluate(async (label, driverSrc) => {
    const stamps = [];
    let on = true;
    const tick = (t) => { stamps.push(t); if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const longTasks = [];
    let po;
    try {
      po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)); });
      po.observe({ type: 'longtask', buffered: false });
    } catch {}
    const start = performance.now();
    await (new Function('return (' + driverSrc + ')')())();
    const dur = performance.now() - start;
    on = false;
    po?.disconnect();
    const dts = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    const pct = (p) => dts.length ? Math.round(dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] * 10) / 10 : null;
    return {
      label, seconds: Math.round(dur / 100) / 10, frames: stamps.length,
      fps: Math.round((stamps.length / (dur / 1000)) * 10) / 10,
      frameMs: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), worst: dts.length ? Math.round(dts[dts.length - 1]) : null },
      longTasks: { count: longTasks.length, totalMs: longTasks.reduce((a, b) => a + b, 0), worst: Math.max(0, ...longTasks) },
    };
  }, label, driver.toString());

  out.standingStill = await measure('standing still', async () => { await new Promise((r) => setTimeout(r, 4000)); });
  out.changingSections = await measure('changing sections', async () => {
    const s = window.storeScene;
    for (let i = 0; i < 24; i++) { s.moveRight(); await new Promise((r) => setTimeout(r, 350)); }
  });
  out.sectionJumps = await measure('up/down between runs', async () => {
    const s = window.storeScene;
    for (let i = 0; i < 12; i++) { (i % 2 ? s.moveUp() : s.moveDown()); await new Promise((r) => setTimeout(r, 600)); }
  });

  const rep = await page.evaluate(() => window.__perfTrace?.report());
  if (rep) {
    out.perfTrace = { frames: rep.frames, dtMs: rep.dtMs, hitchCount: rep.hitches?.length, longTaskCount: rep.longTasks?.length };
    // Which spans dominate the hitches: sum each slot across every hitch.
    const agg = {};
    for (const h of rep.hitches || []) for (const [k, v] of Object.entries(h.slots || {})) agg[k] = (agg[k] || 0) + v;
    out.hitchAttribution = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}=${Math.round(v)}`);
    out.worstHitches = (rep.hitches || []).sort((a, b) => b.dt - a.dt).slice(0, 5)
      .map((h) => ({ dt: Math.round(h.dt), top: Object.entries(h.slots || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${Math.round(v)}`) }));
  }
  out.consoleCalibration = logs.slice(0, 8);
} catch (e) {
  out.error = String(e.message || e);
} finally {
  await browser.close();
  vite.kill();
}
console.log(JSON.stringify(out, null, 2));
