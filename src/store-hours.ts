// Store hours + a clock-driven outside mode.
//
// The closed sign in the screensaver promises "COME BACK DURING STORE HOURS"
// and no hours existed anywhere; bb_outside is a manual cycle plus a random
// boot roll. This module closes that loop with two settings:
//
//   bb_store_hours  — "9:00-21:00" (24h, open span; blank = feature off)
//   bb_clock_env    — drive the outside mode by the wall clock when on
//
// When the store is CLOSED (hours set + outside the span): the outside mode
// flips to night and the closed screensaver's promise is at least true. When
// open, the hour picks day/sunset/night exactly as the manual bb_outside
// cycle does. Pure functions live here so tests can pin the arithmetic;
// the scheduler lives in main.ts (a 5-minute interval, cheap reads).
//
// Nothing here knows about the scene — applyClockDrivenLook takes a tiny
// interface so this module stays node-testable.

export interface StoreHoursSpec {
  openHour: number;
  closeHour: number;
}

/** Parse "9:00-21:00" / "9-21" (24h clock). Null = not configured/garbage. */
export function parseStoreHours(spec: string | null | undefined): StoreHoursSpec | null {
  if (!spec) return null;
  const m = /^\s*(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?\s*$/.exec(spec);
  if (!m) return null;
  const openHour = Number(m[1]);
  const closeHour = Number(m[2]);
  if (openHour === closeHour || openHour > 23 || closeHour > 24 || openHour < 0 || closeHour < 0) return null;
  return { openHour, closeHour: closeHour === 24 ? 0 : closeHour };
}

/**
 * Is the store open at `hour` (0-23)? A span crossing midnight (20-2) is
 * supported: "open" is the half-open interval [open, close) — either the
 * plain wrap or the midnight-crossing one.
 */
export function storeIsOpenAtHour(hour: number, spec: StoreHoursSpec): boolean {
  if (spec.openHour === spec.closeHour) return true; // 24-hour store
  if (spec.openHour < spec.closeHour) return hour >= spec.openHour && hour < spec.closeHour;
  return hour >= spec.openHour || hour < spec.closeHour; // crosses midnight
}

/** Which sky is up at `hour`, matching bb_outside's manual cycle vocabulary. */
export function outsideModeForHour(hour: number): 'day' | 'sunset' | 'night' {
  if (hour >= 8 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'sunset';
  return 'night';
}

// The two hooks a scheduler needs, satisfied by StoreScene. Kept as an
// interface rather than importing three-scene: this file runs in tests.
export interface ClockDrivenStore {
  getOutsideMode(): 'day' | 'night' | 'sunset';
  setOutsideMode(mode: 'day' | 'night' | 'sunset'): void;
}

/**
 * Apply the clock's verdict. Returns the mode applied, or null when the
 * store was already wearing it (callers can skip the render wake).
 */
export function applyClockDrivenLook(store: ClockDrivenStore, hour: number): 'day' | 'sunset' | 'night' | null {
  const spec = parseStoreHours(readStoreHoursSetting());
  if (!spec) return null; // hours not configured — manual mode owns the dial
  const target = storeIsOpenAtHour(hour, spec) ? outsideModeForHour(hour) : 'night';
  if (store.getOutsideMode() === target) return null;
  store.setOutsideMode(target);
  return target;
}

// Read straight from localStorage — this module must stay import-free of
// settings.ts (same reasoning as door-chime.ts). Blank/absent = manual.
function readStoreHoursSetting(): string | null {
  try {
    const v = localStorage.getItem('bb_store_hours');
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function storeHoursConfigured(): boolean {
  return parseStoreHours(readStoreHoursSetting()) !== null;
}

/**
 * One 5-minute scheduler for the clock-driven look, armed once per session.
 * Runs unconditionally — a store without hours is a cheap no-op read per
 * tick — so a midnight-spanning store turns itself down at close with no
 * input, and a rebuild inherits the schedule for free.
 */
export function scheduleClockDrivenLook(getStore: () => ClockDrivenStore | null): void {
  if (typeof window === 'undefined') return;
  const tick = () => {
    const store = getStore();
    if (!store) return;
    applyClockDrivenLook(store, new Date().getHours());
  };
  window.setInterval(tick, 5 * 60_000);
}