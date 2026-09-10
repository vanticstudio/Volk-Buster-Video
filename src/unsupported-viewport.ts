// The phone wall.
//
// OWNER RULING: a phone is not a supported way to visit this store. It is a
// walkable 3D shop with a keyboard/remote control scheme, ~100MB of textures
// and a scene budget written for a TV — and the honest answer on a handset is
// to say so, not to serve something that technically renders and is miserable
// to use.
//
// So this is a WALL, not a downgrade. It goes up before the scene builds,
// because the whole point is to not spend a phone's battery and data allowance
// on a store the visitor is about to be told they cannot use.
//
// WHAT COUNTS AS A PHONE, and why it is two tests rather than one:
//
//   size  — src/viewport.ts's isHandheldViewport(), phone-shaped in CSS pixels
//   input — a coarse pointer with no hover, the same signal store-touch.ts uses
//
// Both, because either alone is wrong in a way people actually hit. Size alone
// walls off anyone who narrowed a desktop window, and telling someone on a
// desktop to "continue on a desktop" is the kind of message that makes a
// product look broken. Input alone walls off a touchscreen laptop and a big
// tablet, which have the screen and the horsepower for the real thing.
//
// It re-evaluates on resize, so rotating a tablet or widening a window takes
// the wall down without a reload — a visitor who is told to go elsewhere and
// then does should not also have to know to refresh.

// Explicit .ts specifier: tests/unsupported-viewport.test.ts loads this under
// `node --test`'s type-stripping loader, which cannot resolve a bare sibling
// specifier (same note as playback-flow.ts's own jellyfin.ts import).
import { isHandheldViewport } from './viewport.ts';

/**
 * Is this a handset, as opposed to a small window or a touchscreen laptop?
 *
 * Pure and fully injected so the matrix of size-vs-input can be asserted
 * (tests/unsupported-viewport.test.ts) instead of eyeballed on one device.
 */
export function isUnsupportedViewport(
  width: number,
  height: number,
  touchPrimary: boolean,
): boolean {
  return touchPrimary && isHandheldViewport(width, height);
}

/** The live reading of the two signals, for the running browser. */
export function viewportIsUnsupported(): boolean {
  if (typeof window === 'undefined') return false;
  // No matchMedia: an environment that old is not a phone, and guessing "yes"
  // would wall off the very browsers least able to tell us they are fine.
  const coarse = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
    && window.matchMedia('(hover: none)').matches;
  return isUnsupportedViewport(window.innerWidth, window.innerHeight, coarse);
}

const ID = 'unsupported-viewport';

const CSS = `
#${ID} {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  padding: 28px calc(24px + env(safe-area-inset-right)) calc(28px + env(safe-area-inset-bottom))
           calc(24px + env(safe-area-inset-left));
  background: #0d1018; color: #f2e8c9;
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-align: center;
  /* The store's own light: a warm pool from above, brick-dark at the edges —
     mirrors the sign-in page so the two read as one product. */
  background-image:
    radial-gradient(120% 90% at 50% -10%, rgba(26,73,194,.22), transparent 60%),
    radial-gradient(80% 60% at 50% 110%, rgba(242,232,201,.06), transparent 70%);
}
#${ID} .inner { max-width: 22rem; }
#${ID} .sign {
  background: #1a49c2; border: 3px solid #f2e8c9; border-radius: 5px;
  padding: 14px 16px 12px; margin: 0 0 24px;
}
#${ID} .sign b {
  display: block; font-family: 'Archivo Black', 'Arial Black', sans-serif;
  font-size: clamp(24px, 8.5vw, 34px); line-height: .94; color: #f2e8c9;
}
#${ID} .sign span {
  display: block; margin-top: 5px; font-size: 11px; letter-spacing: .34em;
  text-transform: uppercase; color: rgba(242,232,201,.82);
}
#${ID} h1 {
  font-family: 'Archivo Black', 'Arial Black', sans-serif;
  font-size: 18px; line-height: 1.3; margin: 0 0 10px; text-wrap: balance;
}
`;

/**
 * Put the wall up (or take it down) to match the current viewport.
 *
 * Builds its own DOM rather than living in index.html so the markup cannot be
 * served, and briefly flash, to the desktop visitors it does not apply to.
 *
 * Returns whether the wall is up, so the caller can skip booting the store.
 */
export function applyUnsupportedViewportNotice(): boolean {
  if (typeof document === 'undefined') return false;
  const unsupported = viewportIsUnsupported();
  const existing = document.getElementById(ID);

  if (!unsupported) {
    existing?.remove();
    return false;
  }
  if (existing) return true;

  const style = document.createElement('style');
  style.textContent = CSS;
  const el = document.createElement('div');
  el.id = ID;
  el.setAttribute('role', 'alert');
  const inner = document.createElement('div');
  inner.className = 'inner';

  const sign = document.createElement('div');
  sign.className = 'sign';
  const b = document.createElement('b');
  b.textContent = 'VOLKBUSTER';
  const span = document.createElement('span');
  span.textContent = 'Video';
  sign.append(b, span);

  const h1 = document.createElement('h1');
  h1.textContent = 'Please continue on a desktop or TV instead, as mobile is unsupported.';

  // Built with textContent throughout rather than innerHTML: nothing here is
  // interpolated today, and a wall that renders markup is a wall that becomes
  // an injection point the first time someone puts a title in it.
  inner.append(sign, h1);
  el.append(inner);
  document.head.appendChild(style);
  document.body.appendChild(el);
  return true;
}

/**
 * Watch for the viewport changing shape, and boot late if it becomes supported.
 *
 * THE LATE BOOT IS THE WHOLE REASON THIS TAKES A CALLBACK. Putting the wall up
 * skips the store's boot entirely — that is the point, a phone should not pay
 * to build a scene it is about to be refused. But then taking the wall down on
 * a resize would leave a blank page behind it: nothing has been built, and
 * nothing else is going to try. So the caller hands us its boot function and we
 * run it, exactly once, if the viewport ever grows into a supported one.
 *
 * Only when boot was actually skipped. A desktop that booted normally and then
 * gets narrowed must never be booted a second time.
 *
 * Returns the initial verdict, so the caller can skip its own boot call.
 */
export function watchUnsupportedViewport(boot?: () => void): boolean {
  const up = applyUnsupportedViewportNotice();
  if (typeof window === 'undefined') return up;

  let bootSkipped = up;
  window.addEventListener('resize', () => {
    const stillUp = applyUnsupportedViewportNotice();
    if (stillUp || !bootSkipped) return;
    // Grew into a supported viewport with nothing built behind the wall.
    bootSkipped = false;
    console.log('[System] Viewport is supported now — booting the store.');
    boot?.();
  });
  return up;
}
