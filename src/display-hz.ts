// Compositor refresh rate, sampled once at boot from requestAnimationFrame
// cadence — there is no web API that reports it directly. The dynamic
// resolution scaler (StoreScene.updateDynamicResolution) reads this to pick
// its fps target: a 120Hz display should chase 120, not the hardcoded 50/58
// thresholds the scaler shipped with when every display was assumed 60Hz.
//
// The harness never calls measureDisplayHz(), so headless perf runs keep the
// deterministic 60Hz thresholds and stay comparable across sessions.

const KNOWN_RATES = [60, 75, 90, 100, 120, 144, 165, 240];

let measured = 60;

/** Best-known compositor refresh rate; 60 until measureDisplayHz() resolves. */
export function displayHz(): number {
  return measured;
}

/**
 * ACTIVE-tier render cap (issue: the composer chain — N8AO/bloom/bokeh/FXAA
 * at up to a 3.7MP supersampled buffer — used to chase the raw display rate,
 * so a 144/165/240Hz monitor ran the full chain at full refresh for no visual
 * gain, and the dynamic resolution scaler's fps target scaled with it too,
 * so those displays actively lowered render resolution chasing 144+fps).
 *
 * Picks an EVEN DIVISOR of the display rate so the paced cadence lands on
 * every Nth vsync exactly (120→60, 144→72, 165→82.5, 240→60, 60→60) instead
 * of a fractional target that beats against the compositor. `override` is
 * the raw bb_fps_cap localStorage value, read once at construction: null or
 * 'auto' (unset, or the SERVICE MODE row's default cycle position — see
 * settings.ts) targets 60; '0' disables the cap outright (divisor 1, i.e.
 * today's uncapped behavior); any other finite number targets that instead
 * of 60, clamped to 24..hz so a stray value can't stall the renderer or ask
 * for faster than the display can present.
 */
export function computeFpsCap(hz: number, override: string | null): number {
  if (override === '0') return hz;
  let targetFps = 60;
  if (override !== null && override !== 'auto') {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) targetFps = Math.min(hz, Math.max(24, n));
  }
  const divisor = Math.max(1, Math.floor(hz / targetFps));
  return hz / divisor;
}

/**
 * Ceiling on the fps target the RESOLUTION SCALER chases — deliberately not the
 * same number as the presentation cap above.
 *
 * Uncapped presentation (`bb_fps_cap` '0', which the calibrated supersample
 * grant turns on by default) makes computeFpsCap return the panel's real
 * refresh, and updateDynamicResolution derives its step thresholds from that:
 * on a 144Hz display it will not step resolution back up until the scene holds
 * ~140fps. A mid-range GPU cannot reach that in this scene at ANY resolution —
 * motion-frame cost here is largely pixel-independent (AO recompute + draw-call
 * submission), the same measurement the 0.83x down-threshold rests on. So the
 * scaler walks resScale down 0.05/s to its floor, can never climb back, and the
 * store renders permanently soft — while the settle frame, an ABSOLUTE pixel
 * target divided by resScale, stays sharp. Every camera nudge then pops between
 * the two, which reads as the resolution flickering rather than as a scaler
 * doing its job.
 *
 * Chasing a rate the pixel budget cannot buy was never the scaler's job: it
 * exists so frames that must land in 16ms do. Bound its target here and leave
 * presentation uncapped, so capable hardware still chases the panel (owner
 * ruling 2026-08-05) while the scaler defends a reachable floor.
 */
export const SCALER_TARGET_FPS_CAP = 60;

/**
 * The fps target updateDynamicResolution measures against. Below the cap the
 * scaler still defends whatever the render cap asked for (an explicit
 * bb_fps_cap of 30 is defended at 30); above it, the extra refresh is a
 * presentation concern, not a resolution one.
 */
export function computeScalerTargetFps(targetFps: number): number {
  if (!Number.isFinite(targetFps) || targetFps <= 0) return SCALER_TARGET_FPS_CAP;
  return Math.min(targetFps, SCALER_TARGET_FPS_CAP);
}

/**
 * The store's frame-rate target (owner ruling 2026-09-11, replacing the
 * 2026-08-05 "capable hardware runs uncapped" ruling): "i just simply want this
 * thing to run at a standard 30 frames per second in the actual store."
 *
 * It is the DEFAULT, not a ceiling nobody can lift — an explicit bb_fps_cap
 * (the SERVICE MODE row) still wins, so a kiosk that wants its panel's refresh
 * sets '0' or '60'. Video playback is unaffected: the player is a DOM <video>
 * overlay composited at the display's own rate.
 *
 * Why 30 fixes more than smoothness: the resolution scaler steps down whenever
 * a one-second window measures under SCALER_DOWN_FACTOR of its target. Aimed
 * at 60 that is any dip below 50, which every section change produced, and
 * each step reallocates the whole post-processing chain — a stall that reads as
 * the next dip. Aimed at 30 the trigger is 25, which a store holding 45-60
 * never reaches.
 */
export const STORE_TARGET_FPS = 30;

/**
 * Down/up thresholds, as fractions of the scaler's target.
 *
 * The classic 50/58 pair was 60Hz tuning (0.83x / 0.97x); a 120Hz display got
 * 100/116. Measured on the RX 9070 XT: motion-frame cost is mostly pixel-
 * independent (AO recompute + draw-call submission), so a tighter band just
 * parks the scale at the floor for no fps — 0.83x is the right down-threshold.
 * Bounded by SCALER_TARGET_FPS_CAP through computeScalerTargetFps, for the
 * reason that function documents.
 *
 * Moved here from three-scene.ts, which sits at its line budget, so the numbers
 * the scaler actually acts on can be asserted.
 */
export const SCALER_DOWN_FACTOR = 0.83;
export const SCALER_UP_FACTOR = 0.97;

export function scalerThresholds(targetFps: number): { downAt: number; upAt: number } {
  const target = computeScalerTargetFps(targetFps);
  return { downAt: target * SCALER_DOWN_FACTOR, upAt: target * SCALER_UP_FACTOR };
}

/**
 * How long the scaler ignores the frame clock after ANY drawing-buffer resize.
 *
 * A RESIZE IS NOT A GPU VERDICT — the rule the scaler already applied to texture
 * uploads, never to itself. applyRenderResolution() rebuilds every render target
 * in the chain synchronously (15 on a medium-tier store: the composer's pair,
 * the beauty target, bloom's bright pass plus five horizontal and five vertical
 * mips, and bokeh's depth), and the next composite pays first-draw into all of
 * them. Measured on an M4 Pro across 20 section changes: WebGLRenderer.setSize
 * was the hottest function in the app at 887 ms of self time, 818 ms of it
 * arriving through the scaler.
 *
 * Without this that stall is the first thing the next window counts. It reads
 * as a slow GPU, the scaler steps down, which resizes, which stalls — the
 * staircase the log shows running from 1.0 to the 0.5 floor, leaving the store
 * stuttering AND blurry. One full measurement window covers the rebuild.
 */
export const RESIZE_GRACE_MS = 1000;

/**
 * Fire-and-forget boot sampling: ~45 rAF ticks (≲0.5s), fastest decile wins.
 * Boot-time texture decode janks individual frames, which only ever makes
 * deltas LONGER — the fastest ticks are the compositor's true cadence. The
 * result snaps to the nearest standard rate, and anything that isn't
 * decisively quicker than a 60Hz tick stays 60.
 */
export function measureDisplayHz(): void {
  if (typeof requestAnimationFrame === 'undefined') return;
  const deltas: number[] = [];
  let prev = 0;
  let n = 0;
  const tick = (t: number) => {
    if (prev) deltas.push(t - prev);
    prev = t;
    if (++n < 45) {
      requestAnimationFrame(tick);
      return;
    }
    deltas.sort((a, b) => a - b);
    const fast = deltas[Math.floor(deltas.length * 0.1)];
    if (!(fast > 0)) return;
    const hz = 1000 / fast;
    if (hz <= 70) return; // not measurably faster than 60 — keep the default
    let best = KNOWN_RATES[0];
    for (const r of KNOWN_RATES) {
      if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
    }
    measured = best;
    console.log(`[displayHz] rAF fast-decile ${fast.toFixed(2)}ms → ${measured}Hz`);
  };
  requestAnimationFrame(tick);
}
