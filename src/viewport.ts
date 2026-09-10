// How the store frames itself for the screen it is actually on.
//
// THE PROBLEM. three.js's PerspectiveCamera fov is the VERTICAL angle, and the
// store asks for a fixed 60°. On a 16:9 desktop that works out to 91.5°
// horizontally, which is the framing every camera position in store-camera.ts
// was placed against. Turn the same camera sideways onto a phone and the
// horizontal field collapses with the aspect ratio:
//
//   desktop 16:9        aspect 1.778   91.5° horizontal
//   iPad landscape      aspect 1.333   75.2°
//   iPad portrait       aspect 0.750   46.8°
//   iPhone portrait     aspect 0.462   29.9°   <- a third of the desktop view
//
// A 30° cone is a letterbox slot. You are standing in a video shop looking
// through a mail slot: the case in front of you is there, the aisle it sits in
// is not, and there is no way to tell where you are.
//
// THE FIX is the one games have used since the first widescreen monitors,
// usually called Hor+: hold the HORIZONTAL field constant and let the vertical
// one give, instead of the other way round. Below the reference aspect the
// vertical fov opens up until the horizontal cone is back where it was.
//
// Except that pure Hor+ overshoots badly at phone aspects — preserving 91.5°
// horizontally at 0.462 needs a 131° vertical fov, which is a fisheye. So it
// is clamped. The clamp is what actually applies on any phone; the
// interpolation between it and the reference aspect is what serves tablets,
// split-screen windows and half-width desktop browsers.
//
// This module is pure and DOM-free so the numbers above can be asserted rather
// than eyeballed (tests/viewport.test.ts) — the same reason counter-terminal.ts
// holds the CRT geometry instead of the module that draws it.

/** The vertical fov the store was framed at, and still uses at 16:9 and wider. */
export const BASE_FOV = 60;

/**
 * The aspect the store's camera placements were composed for. At or above it
 * nothing changes at all — a wider screen keeps showing more store, which is
 * the whole point of a wider screen.
 */
export const REFERENCE_ASPECT = 16 / 9;

/**
 * The ceiling on how far the vertical fov may open.
 *
 * 80° vertical at a 0.462 phone aspect is 42.4° horizontal — a 42% wider view
 * than the 29.9° a fixed 60° gives, and about what a 50mm lens sees. Pushing
 * further buys diminishing width for accelerating distortion: the shelves at
 * the edge of frame start to lean, and a store full of straight verticals is
 * exactly the scene that shows it.
 */
export const MAX_FOV = 80;

const DEG = Math.PI / 180;

/** Horizontal field, in degrees, for a vertical fov at an aspect ratio. */
export function horizontalFov(verticalFov: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((verticalFov * DEG) / 2) * aspect) / DEG;
}

/**
 * The vertical fov to use at this aspect ratio.
 *
 * Guards a zero or garbage aspect back to the base fov rather than propagating
 * NaN into the projection matrix: `container.clientWidth` is legitimately 0
 * during layout, on a hidden tab, and in the frame before a rotation settles,
 * and a NaN there does not throw — it silently renders nothing at all.
 */
export function fovForAspect(
  aspect: number,
  base = BASE_FOV,
  reference = REFERENCE_ASPECT,
  max = MAX_FOV,
): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return base;
  if (aspect >= reference) return base;
  // The horizontal half-angle the reference framing has, re-solved for this
  // narrower aspect. tan(hHalf) = tan(vHalf) * aspect, so holding hHalf fixed
  // means tan(vHalf) = tan(hHalf) / aspect.
  const hHalf = Math.atan(Math.tan((base * DEG) / 2) * reference);
  const vFov = 2 * Math.atan(Math.tan(hHalf) / aspect) / DEG;
  return Math.min(max, vFov);
}

/**
 * Is this viewport a handheld — a phone or a phone-shaped window?
 *
 * SIZE, NOT ASPECT. A 400px-wide column on a desktop is the same rendering
 * problem as a phone, and a tablet in landscape is not a phone however coarse
 * its pointer is. Measured in CSS pixels, which are already normalised across
 * device pixel ratios, so a 3x phone and a 1x phone answer the same.
 *
 * Deliberately NOT the `(pointer: coarse) and (hover: none)` test that
 * store-touch.ts uses to decide whether to draw touch controls. Those are
 * different questions: that one asks what the visitor can DO, this asks what
 * the GPU is being asked to fill. A tablet needs the touch layer and does not
 * need the handheld render budget.
 */
export function isHandheldViewport(width: number, height: number): boolean {
  // A zero size is not a small screen, it is an unmeasured one — a container
  // mid-layout, a hidden tab, the frame before a rotation settles. Treating it
  // as a phone would pin the reduced budget on a desktop over one bad read,
  // and nothing re-measures it afterwards.
  if (!(width > 0) || !(height > 0)) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return Math.min(width, height) < 500 && Math.max(width, height) < 950;
}

/**
 * The ceiling on renderer pixel ratio for a handheld.
 *
 * The store supersamples: applyRenderResolution solves for the multiplier that
 * spends a ~3.7M-pixel budget, and a phone's viewport is ~330k CSS pixels, so
 * the budget never binds there — the tier's own pixel-ratio cap does, and it
 * would happily render 2x on a mobile GPU carrying the full post stack.
 *
 * 1.5 puts a 414x896 phone at roughly 620x1340, still above its own CSS
 * resolution so edges stay clean, at ~44% of the fragment cost of 2x. Frame
 * rate is what makes a store feel walkable; a slightly softer frame is not
 * what anyone notices on a 6-inch screen, and a 22fps one is.
 */
export const HANDHELD_PIXEL_RATIO_CAP = 1.5;

/**
 * The tier's pixel-ratio cap, lowered if this is a handheld.
 *
 * Lives here rather than inline in three-scene.ts because that file is at its
 * line budget — which is the budget doing its job: the spine should say WHICH
 * cap applies, and this module should say why.
 */
export function pixelRatioCap(tierCap: number, width: number, height: number): number {
  return isHandheldViewport(width, height) ? Math.min(tierCap, HANDHELD_PIXEL_RATIO_CAP) : tierCap;
}
