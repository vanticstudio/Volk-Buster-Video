// Framing the store for the screen it is actually on.
//
// The bug these pin: a fixed 60° VERTICAL fov gives 91.5° horizontally on a
// 16:9 desktop and 29.9° on a portrait phone. Every camera position in
// store-camera.ts was composed against the first number, so on a phone the
// visitor is looking at the store through a mail slot — the case is there, the
// aisle it sits in is not.
//
// Written as numbers rather than a screenshot because that is the only form
// that survives: a phone-shaped screenshot proves the framing on one device on
// one day, and these say what the framing IS at every aspect the store can be
// handed.
//
//   npm run test:viewport

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_FOV,
  MAX_FOV,
  REFERENCE_ASPECT,
  fovForAspect,
  horizontalFov,
  isHandheldViewport,
} from '../src/viewport.ts';

/** What the store shows horizontally at a given viewport, after the fix. */
const view = (w: number, h: number) => horizontalFov(fovForAspect(w / h), w / h);

// ─── The screens that were broken ───────────────────────────────────────────

test('a portrait phone is no longer looking through a mail slot', () => {
  // The headline number. 29.9° before, and a shelf run subtends more than that.
  const after = view(414, 896);
  const before = horizontalFov(BASE_FOV, 414 / 896);
  assert.ok(before < 31, `sanity: the old framing really was ${before.toFixed(1)}°`);
  assert.ok(after > 40, `expected a usable field, got ${after.toFixed(1)}°`);
  assert.ok(after / before > 1.35, 'the fix must be worth having, not a rounding change');
});

test('every phone-shaped viewport clears the same bar', () => {
  // Not just the one device that was measured. The narrowest common phone
  // aspect is the tallest handset in portrait; the widest is an older 16:9.
  for (const [w, h] of [[360, 800], [375, 667], [390, 844], [414, 896], [430, 932]]) {
    const got = view(w, h);
    assert.ok(got > 40, `${w}x${h} got ${got.toFixed(1)}° horizontally`);
  }
});

test('a tablet in portrait gets the interpolated fov, not the clamp floor', () => {
  // 0.75 is above where the clamp bites, so it should land between the base
  // and the ceiling — proving the curve exists rather than being a phone
  // special case wearing a general-purpose name.
  const fov = fovForAspect(768 / 1024);
  assert.ok(fov > BASE_FOV, 'a tablet in portrait needs more than the base');
  assert.equal(fov, MAX_FOV, 'though 4:3 portrait is narrow enough to reach the ceiling');
  // The genuinely intermediate case: a half-width desktop window.
  const half = fovForAspect(1.4);
  assert.ok(half > BASE_FOV && half < MAX_FOV, `expected a middle value, got ${half}`);
});

// ─── The screens that were fine ─────────────────────────────────────────────

test('16:9 and wider are untouched', () => {
  // The store was composed at 16:9 and there is nothing to fix there. A change
  // here would silently re-frame every camera position in store-camera.ts.
  assert.equal(fovForAspect(16 / 9), BASE_FOV);
  assert.equal(fovForAspect(21 / 9), BASE_FOV, 'ultrawide keeps showing more store');
  assert.equal(fovForAspect(32 / 9), BASE_FOV);
});

test('the reference aspect is exactly the hinge', () => {
  assert.equal(fovForAspect(REFERENCE_ASPECT), BASE_FOV);
  assert.ok(fovForAspect(REFERENCE_ASPECT - 0.01) > BASE_FOV);
});

test('the fov only ever widens, never narrows', () => {
  // A narrower screen showing LESS vertically than a wide one would crop the
  // shelf tops — the opposite of the intent, and the easy sign error here.
  for (let a = 0.3; a < 3; a += 0.05) {
    assert.ok(fovForAspect(a) >= BASE_FOV, `aspect ${a.toFixed(2)} narrowed to ${fovForAspect(a)}`);
  }
});

test('fov is monotonic: narrower is never given less', () => {
  let prev = fovForAspect(0.3);
  for (let a = 0.3; a < 2.5; a += 0.02) {
    const fov = fovForAspect(a);
    assert.ok(fov <= prev + 1e-9, `fov rose from ${prev} to ${fov} going wider at ${a.toFixed(2)}`);
    prev = fov;
  }
});

// ─── The clamp ──────────────────────────────────────────────────────────────

test('the vertical fov is never allowed to fisheye', () => {
  // Pure Hor+ asks for 131° at a phone aspect. A store is full of straight
  // verticals — shelf uprights, door frames, the window mullions — and they
  // are exactly what visibly bends when the fov runs away.
  for (const a of [0.2, 0.3, 0.462, 0.6, 0.75, 1.0]) {
    assert.ok(fovForAspect(a) <= MAX_FOV, `aspect ${a} asked for ${fovForAspect(a)}°`);
  }
});

test('a square viewport is handled, not treated as an edge case', () => {
  const fov = fovForAspect(1);
  assert.equal(fov, MAX_FOV);
  assert.ok(horizontalFov(fov, 1) > 70);
});

// ─── Degenerate input ───────────────────────────────────────────────────────

test('a zero or garbage aspect falls back rather than poisoning the matrix', () => {
  // container.clientWidth is legitimately 0 during layout, on a hidden tab and
  // in the frame before a rotation settles. A NaN fov does not throw — it
  // renders an empty canvas, which is a much worse failure than a wrong angle.
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(fovForAspect(bad), BASE_FOV, `aspect ${bad} must fall back`);
  }
});

// ─── Which viewports count as handheld ──────────────────────────────────────

test('phones are handheld and desktops are not', () => {
  assert.ok(isHandheldViewport(414, 896), 'phone portrait');
  assert.ok(isHandheldViewport(896, 414), 'phone landscape — the same GPU');
  assert.ok(!isHandheldViewport(1512, 788), 'laptop');
  assert.ok(!isHandheldViewport(3840, 2160), 'the kiosk TV');
});

test('a tablet is not handheld', () => {
  // It needs the touch layer, which is a different question — see the note in
  // viewport.ts. It does not need the reduced render budget.
  assert.ok(!isHandheldViewport(1024, 768), 'tablet landscape');
  assert.ok(!isHandheldViewport(768, 1024), 'tablet portrait');
});

test('a narrow desktop column is handheld, because the GPU cost is the same', () => {
  // Size, not device class. A 400px-wide window has a phone's pixel count and
  // wants a phone's budget, whatever it is running on.
  assert.ok(isHandheldViewport(400, 900));
});

test('an unmeasured viewport is not handheld', () => {
  // A zero size is not a small screen — it is a container mid-layout, a hidden
  // tab, the frame before a rotation settles. Falling back to the FULL budget
  // is the safe direction: it renders correctly and merely costs more, where
  // the reverse pins a permanently softened frame on a desktop over one bad
  // read that nothing re-measures.
  assert.ok(!isHandheldViewport(0, 0), 'zero is unmeasured, not tiny');
  assert.ok(!isHandheldViewport(0, 900), 'and so is a zero in one axis');
  assert.ok(!isHandheldViewport(NaN, NaN));
  assert.ok(!isHandheldViewport(-414, -896));
});
