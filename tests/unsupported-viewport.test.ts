// The phone wall: who gets turned away, and — more importantly — who does not.
//
// The failure mode worth testing is the FALSE POSITIVE. Telling someone on a
// desktop to "continue on a desktop" makes the product look broken, and the two
// ways to earn that message are a narrowed browser window and a touchscreen
// laptop. Both are common, neither is a phone, and each would be caught by one
// of the two signals on its own — which is why there are two.
//
//   npm run test:unsupportedviewport

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnsupportedViewport } from '../src/unsupported-viewport.ts';

const TOUCH = true;
const MOUSE = false;

// ─── Turned away ────────────────────────────────────────────────────────────

test('a phone in portrait is turned away', () => {
  assert.equal(isUnsupportedViewport(414, 896, TOUCH), true);
});

test('a phone in landscape is turned away too', () => {
  // Rotating does not make a handset a TV, and the store's control scheme is
  // no more reachable sideways.
  assert.equal(isUnsupportedViewport(896, 414, TOUCH), true);
});

test('every common handset size is turned away', () => {
  for (const [w, h] of [[360, 800], [375, 667], [390, 844], [414, 896], [430, 932]]) {
    assert.equal(isUnsupportedViewport(w, h, TOUCH), true, `${w}x${h} got through`);
  }
});

// ─── NOT turned away — the false positives that matter ──────────────────────

test('a narrowed desktop window is NOT turned away', () => {
  // Phone-SIZED, but driven by a mouse. Size alone would wall this off, and
  // telling someone on a desktop to continue on a desktop is the message that
  // makes a product look broken.
  assert.equal(isUnsupportedViewport(400, 900, MOUSE), false);
});

test('a touchscreen laptop is NOT turned away', () => {
  // Coarse pointer, but it has the screen and the horsepower for the real
  // thing. Input alone would wall this off.
  assert.equal(isUnsupportedViewport(1512, 982, TOUCH), false);
});

test('a tablet is NOT turned away, in either orientation', () => {
  // The case the two-signal test exists to protect. A big touch screen is a
  // fine way to walk around a shop.
  assert.equal(isUnsupportedViewport(1024, 768, TOUCH), false);
  assert.equal(isUnsupportedViewport(768, 1024, TOUCH), false);
});

test('the kiosk TV is never touched by this', () => {
  assert.equal(isUnsupportedViewport(3840, 2160, MOUSE), false);
  assert.equal(isUnsupportedViewport(3840, 2160, TOUCH), false);
});

// ─── Both signals are genuinely required ────────────────────────────────────

test('neither signal alone turns anyone away', () => {
  // Stated as a property rather than trusting the two cases above to stay
  // representative: for every size, a mouse means supported.
  for (const [w, h] of [[414, 896], [360, 800], [896, 414]]) {
    assert.equal(isUnsupportedViewport(w, h, MOUSE), false, `${w}x${h} walled a mouse user`);
  }
  // And for every touch device big enough, supported.
  for (const [w, h] of [[1024, 768], [1280, 800], [1512, 982]]) {
    assert.equal(isUnsupportedViewport(w, h, TOUCH), false, `${w}x${h} walled a tablet`);
  }
});

// ─── Degenerate input ───────────────────────────────────────────────────────

test('an unmeasured viewport is not walled off', () => {
  // A container mid-layout or a hidden tab reports 0. Walling on that would
  // turn a desktop visitor away during a layout pass, and the wall would then
  // need something to take it back down. Failing open is the right direction:
  // the worst case is a phone briefly seeing the store it is about to be told
  // it cannot use, and the resize listener corrects it.
  assert.equal(isUnsupportedViewport(0, 0, TOUCH), false);
  assert.equal(isUnsupportedViewport(NaN, NaN, TOUCH), false);
});
