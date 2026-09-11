// Unit tests for the two pure fps-target rules in display-hz.ts: the
// presentation cap (computeFpsCap, which picks an even divisor of the panel's
// refresh) and the resolution scaler's separate, bounded target
// (computeScalerTargetFps).
//
//   npm run test:displayhz
//
// Runs under plain `node --test` with type stripping — no test framework.
// measureDisplayHz() is not covered here: it needs a live rAF cadence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFpsCap,
  computeScalerTargetFps,
  SCALER_TARGET_FPS_CAP,
  RESIZE_GRACE_MS,
  STORE_TARGET_FPS,
  scalerThresholds,
  STORE_MOTION_SS,
  STORE_SETTLE_SS,
} from '../src/display-hz.ts';

test('computeFpsCap targets 60 by default, on an even divisor of the panel', () => {
  assert.equal(computeFpsCap(60, null), 60);
  assert.equal(computeFpsCap(120, null), 60);
  assert.equal(computeFpsCap(144, null), 72);
  assert.equal(computeFpsCap(165, null), 82.5);
  assert.equal(computeFpsCap(240, null), 60);
  // 'auto' is the SERVICE MODE row's default cycle position, same as unset.
  assert.equal(computeFpsCap(144, 'auto'), 72);
});

test("computeFpsCap '0' presents uncapped at the panel's real refresh", () => {
  assert.equal(computeFpsCap(60, '0'), 60);
  assert.equal(computeFpsCap(144, '0'), 144);
  assert.equal(computeFpsCap(240, '0'), 240);
});

test('computeFpsCap clamps an explicit override to 24..hz', () => {
  assert.equal(computeFpsCap(144, '30'), 36); // 144/floor(144/30) = 144/4
  assert.equal(computeFpsCap(60, '1000'), 60); // never faster than the panel
  assert.equal(computeFpsCap(60, '5'), 30); // floored at 24, then the even divisor
});

test('computeFpsCap ignores a non-numeric override rather than stalling', () => {
  assert.equal(computeFpsCap(120, 'nonsense'), 60);
});

test('the scaler target never chases a rate resolution cannot buy', () => {
  // The bug this guards: uncapped presentation on a high-refresh panel put the
  // step-up threshold at ~0.97 x 144 = 140fps, which a mid-range GPU cannot
  // reach in this scene at any resolution — so resScale walked to its floor
  // and could never climb back out.
  assert.equal(computeScalerTargetFps(144), SCALER_TARGET_FPS_CAP);
  assert.equal(computeScalerTargetFps(165), SCALER_TARGET_FPS_CAP);
  assert.equal(computeScalerTargetFps(240), SCALER_TARGET_FPS_CAP);
  assert.ok(computeScalerTargetFps(144) * 0.97 < 60);
});

test('the scaler still defends a target below the cap', () => {
  assert.equal(computeScalerTargetFps(60), 60);
  assert.equal(computeScalerTargetFps(30), 30);
  assert.equal(computeScalerTargetFps(72), SCALER_TARGET_FPS_CAP);
});

test('the scaler target survives a garbage fps target', () => {
  assert.equal(computeScalerTargetFps(0), SCALER_TARGET_FPS_CAP);
  assert.equal(computeScalerTargetFps(-1), SCALER_TARGET_FPS_CAP);
  assert.equal(computeScalerTargetFps(NaN), SCALER_TARGET_FPS_CAP);
});

// ─── The store's 30 FPS target and the resize feedback loop ─────────────────
//
// Measured on an M4 Pro: standing still held 59 fps; changing sections fell to
// 14, with main-thread blocks of ~250 ms. A CPU profile named
// WebGLRenderer.setSize the hottest function in the app, and 818 of its 887 ms
// came through the resolution scaler — which stepped down, rebuilt every render
// target, measured that rebuild as a slow GPU, and stepped down again, all the
// way from 1.0 to the 0.5 floor. These pin the halves of the fix that are pure.

test('the store targets 30 fps by default', () => {
  assert.equal(STORE_TARGET_FPS, 30);
});

test('the store target presents at 30 on common panels', () => {
  assert.equal(computeFpsCap(60, String(STORE_TARGET_FPS)), 30);
  assert.equal(computeFpsCap(120, String(STORE_TARGET_FPS)), 30);
});

test('the scaler defends the store target, not 60', () => {
  assert.equal(computeScalerTargetFps(STORE_TARGET_FPS), 30);
});

test('a section-change dip that tripped the scaler at 60 no longer does at 30', () => {
  // The regression, as numbers. A dip to 35 is under 60's down-threshold
  // (49.8) — every section change produced one — and over 30's (24.9), so the
  // scaler no longer starts the staircase at all.
  const dip = 35;
  assert.ok(dip < scalerThresholds(60).downAt, 'sanity: 35 fps did trip the old 60 target');
  assert.ok(dip > scalerThresholds(STORE_TARGET_FPS).downAt, 'and must not trip the store target');
});

test('moving the thresholds did not retune them', () => {
  // They left three-scene.ts for testability, not for new values. 60Hz tuning
  // has always been 50/58.
  const { downAt, upAt } = scalerThresholds(60);
  assert.ok(Math.abs(downAt - 49.8) < 1e-9, `downAt ${downAt}`);
  assert.ok(Math.abs(upAt - 58.2) < 1e-9, `upAt ${upAt}`);
});

test('the thresholds stay bounded on a high-refresh panel', () => {
  // Same SCALER_TARGET_FPS_CAP bound the inline code had.
  assert.deepEqual(scalerThresholds(144), scalerThresholds(SCALER_TARGET_FPS_CAP));
});

test('the resize grace outlasts the rebuild it guards', () => {
  // A 15-target rebuild plus first draw into all of them measured ~100-250 ms.
  // Shorter than that and the rebuild leaks into the next window again.
  assert.ok(RESIZE_GRACE_MS >= 500, `${RESIZE_GRACE_MS} ms cannot cover a rebuild`);
  assert.ok(RESIZE_GRACE_MS > 1000 / STORE_TARGET_FPS, 'must exceed a frame at the target');
});

// ─── Supersampling off in the store ─────────────────────────────────────────
//
// A/B on an M4 Pro over the same 20 section changes: supersampling on rendered
// 10.88 MP while moving and managed 17 composites a second; off, 5.44 MP and 27,
// with the frame-gap median at 33.3 ms — the 30 FPS target. It also stopped most
// of the move/settle resize cycle, because both scales collapse to native.

test('the store does not supersample moving frames by default', () => {
  // three-scene reads this through `factor < 1 ? 0 : factor`, the same path an
  // explicit bb_motion_ss of '0' takes, so off here is exactly the measured off.
  assert.equal(STORE_MOTION_SS, 0);
});

test('the store does not supersample the parked frame by default', () => {
  // Settle supersampling also owned a resize: parking snapped the buffer up to
  // the settle scale, and the next movement snapped it back down.
  assert.equal(STORE_SETTLE_SS, 0);
});

test('an off default resolves through the same gate as an explicit off', () => {
  // The guard three-scene applies to either source. Anything under 1 is off,
  // so 0 from the default and '0' from storage cannot diverge.
  const gate = (factor: number) => (!Number.isFinite(factor) || factor < 1 ? 0 : factor);
  assert.equal(gate(STORE_MOTION_SS), gate(Number('0')));
  assert.equal(gate(STORE_SETTLE_SS), gate(Number('0')));
});
