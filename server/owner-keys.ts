/**
 * Which settings a GUEST may change, and which belong to the owner alone.
 *
 * Upstream Halcyon had exactly one user, so every setting was reachable by
 * whoever was sitting at the screen — including FORGET THIS SERVER, the brand
 * editor and the whole setup terminal. This fork sits on the public internet
 * and puts other people's Plex accounts in that same UI, so the partition has
 * to be real.
 *
 * IT IS ENFORCED HERE, ON THE SERVER. The settings drawer also hides
 * owner-only rows, but that is a courtesy to the viewer, not a control: the
 * config endpoint is reachable directly, and a hidden row is one `fetch` away
 * from being written. This module is what actually refuses.
 *
 * THE SHAPE OF THE RULE — guest list open, owner list closed:
 *
 *   1. Not in the `bb_` settings family?     Nobody writes it here, owner included.
 *   2. In the explicit guest set?            A guest may write it.
 *   3. Anything else?                        Owner only.
 *
 * Rule 3 is the important one. A setting added later and forgotten in this file
 * is locked down, not opened up — the failure mode is "the owner has to allow
 * it", never "a guest silently got it". An allowlist fails safe; a denylist
 * fails open, and a denylist is what a shared deployment cannot afford.
 *
 * Mirrors the spirit of src/store-config-keys.ts, which decides which keys
 * follow a person between machines. That file answers "does this travel?";
 * this one answers "may this person set it at all?".
 */

/** The app's settings family. Anything outside it is not a store setting. */
const SETTINGS_PREFIX = /^bb_/;

/**
 * Settings that describe a viewer's OWN store, which this fork's user model
 * ("their library, their store, your admin") makes per-user.
 *
 * Exact keys. Suffixed families are handled by GUEST_PREFIXES below.
 */
const GUEST_KEYS = new Set([
  // The look of the room — era, lighting, layout, media format.
  'bb_theme',
  'bb_medium',
  'bb_arrangement',
  'bb_outside',
  'bb_ceiling',
  'bb_corner',
  'bb_walldecor',
  'bb_storefront',
  'bb_marquee_bulbs',
  'bb_time_of_day',
  'bb_store_format',
  // Their own browsing preferences.
  'bb_genre_sections',
  'bb_bargain_bin',
  'bb_new_releases',
  'bb_coming_soon',
  'bb_staff_picks',
  'bb_streaming_services',
  'bb_media_release_pin',
  'bb_rental_mode',
  // Their own machine's rendering tier. Device-local rather than shared, but a
  // viewer must be able to turn their own picture down.
  'bb_quality',
  'bb_ao',
  'bb_ssao',
  'bb_aa',
  'bb_fps_cap',
]);

/**
 * Guest-writable families whose keys carry an id suffix.
 *
 * `bb_carrylib_<libraryId>` is per-library and per-person by construction —
 * which libraries a viewer wants on their own shelves.
 */
const GUEST_PREFIXES = [
  'bb_carrylib_',
  'bb_lib_',
];

/** May a guest — a signed-in viewer who is not the owner — write this key? */
export function isGuestWritable(key: string): boolean {
  if (typeof key !== 'string' || !SETTINGS_PREFIX.test(key)) return false;
  if (GUEST_KEYS.has(key)) return true;
  return GUEST_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
}

export type WriteVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The check the config endpoint runs before every write.
 *
 * Returns a reason rather than throwing so the handler can log it and answer
 * 403 with something a person can act on. The reason is safe to show a viewer:
 * it names the rule, never the value or anyone else's state.
 */
export function assertWritable(key: string, isOwner: boolean): WriteVerdict {
  if (typeof key !== 'string' || !SETTINGS_PREFIX.test(key)) {
    // Credentials and connection state live in the session, not in a synced
    // preferences blob. Letting them through here would put a token in a row
    // that follows a person between devices — which is the opposite of what
    // this endpoint is for.
    return { ok: false, reason: `"${key}" is not a store setting` };
  }
  if (isOwner) return { ok: true };
  if (isGuestWritable(key)) return { ok: true };
  return { ok: false, reason: `"${key}" is owner-only` };
}
