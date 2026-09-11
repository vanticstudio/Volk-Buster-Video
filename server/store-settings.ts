/**
 * Which store settings the owner may set from the management console, and what
 * the console is allowed to write into every viewer's browser.
 *
 * WHY A CURATED LIST rather than one generated from src/settings.ts, which is
 * the actual registry:
 *
 *  1. It cannot be generated. src/settings.ts will not import into Node
 *     (extensionless specifiers under moduleResolution "bundler") and will not
 *     bundle either, because modules in its graph do eager top-level work —
 *     src/remote-play.ts:40 reads a bare `location`, src/video-case.ts:1527
 *     constructs a real Worker pool at module scope. This repo already hit that
 *     wall and chose source-scanning: tools/list-slots.mjs regex-scans
 *     video-case.ts for USER_WRAP_SPECS, with the comment "that module's graph
 *     needs real browser globals at import time".
 *
 *  2. A generated list would be correct about the wrong SET. Most of the
 *     registry must never appear here — API keys, internal hostnames, a shell
 *     command, and the render knobs that describe a viewer's DEVICE rather than
 *     the shop. The curation has to exist either way, so generating would buy
 *     accurate labels, not accurate membership.
 *
 * Drift is caught by tests/store-settings.test.ts, which scans the registry as
 * TEXT: every key here must still be registered there, and every key registered
 * there must appear in exactly one of CONSOLE_SETTINGS or EXCLUDED_KEYS. A
 * setting added later and never classified fails the build, which is the drift
 * that actually happens.
 *
 * THESE ARE ENFORCED, NOT SUGGESTED. policyKeys() emits them into every
 * document load and the bootstrap overwrites localStorage, so a value set here
 * is what every viewer gets and keeps. That is the intent — it is the owner's
 * shop — but it is also why the allowlist matters: this is a write primitive
 * aimed at everybody's browser, and RESERVED_KEYS below is what stops it being
 * pointed at the front door's own keys.
 */

export interface ConsoleSettingOption {
  id: string;
  label: string;
}

export interface ConsoleSetting {
  /** The localStorage key the store already reads. */
  key: string;
  label: string;
  section: string;
  control: 'checkbox' | 'dropdown' | 'text';
  /** Dropdown choices. A value outside this list is refused, not coerced. */
  options?: ConsoleSettingOption[];
  /**
   * The store's OWN registered default, restated here so "Store default" can
   * be an explicit choice rather than a deletion. See the note on
   * un-enforcing in admin-config.ts — deleting a key strands every viewer on
   * the last value the owner enforced, with no way to pull them back.
   */
  default: string;
  /** One line of plain English for the console. */
  blurb?: string;
  /** Shown in red: this setting changes the experience for every viewer. */
  warning?: string;
}

export const CONSOLE_SETTINGS: ConsoleSetting[] = [
  { key: 'bb_theme', label: 'Store Theme', section: 'Store Look', control: 'dropdown', options: [{ id: 'bb-1990', label: 'VolkBuster 1990' }, { id: 'bb-1993', label: 'VolkBuster 1993' }, { id: 'bb-2000', label: 'VolkBuster 2000' }, { id: 'bb-2010', label: 'VolkBuster 2010' }], default: 'bb-2010' },
  { key: 'bb_medium', label: 'Media Format', section: 'Store Look', control: 'dropdown', options: [{ id: 'dvd', label: 'DVD' }, { id: 'vhs', label: 'VHS' }], default: 'dvd', blurb: 'Case shape used for every title on the shelves.' },
  { key: 'bb_arrangement', label: 'Shelf Arrangement', section: 'Store Look', control: 'dropdown', options: [{ id: 'herringbone', label: 'Herringbone' }, { id: 'straight', label: 'Straight' }, { id: 'diagonal', label: 'Diagonal' }], default: 'herringbone', blurb: 'How the aisles are oriented on the floor.' },
  { key: 'bb_outside', label: 'Environment', section: 'Store Look', control: 'dropdown', options: [{ id: 'day', label: 'Daytime' }, { id: 'night', label: 'Nighttime' }, { id: 'sunset', label: 'Sunset' }], default: 'day', blurb: 'Time of day seen through the storefront windows.' },
  { key: 'bb_studio_picks', label: 'Featured Studios', section: 'Store Look', control: 'text', default: '' },
  { key: 'bb_tip_jar', label: 'Tip jar on the counter', section: 'Store Look', control: 'checkbox', default: '1', blurb: 'A card and a cup by the register, linking the project’s Ko-fi.' },
  { key: 'bb_storefront', label: 'Storefront', section: 'Building & Storefront', control: 'dropdown', options: [{ id: 'standard', label: 'Standard' }, { id: 'sliding-gray', label: 'Sliding Doors / Gray' }, { id: 'rounded-counter', label: 'Rounded Counter' }, { id: 'usquare-counter', label: 'Half-Square Counter' }], default: 'standard', blurb: 'Doors, storefront window framing, and counter style.' },
  { key: 'bb_ceiling', label: 'Ceiling Height', section: 'Building & Storefront', control: 'dropdown', options: [{ id: 'standard', label: 'Standard' }, { id: 'high', label: 'High' }], default: 'standard', blurb: 'Standard drop ceiling or a raised high-ceiling shell.' },
  { key: 'bb_corner', label: 'Corner Step', section: 'Building & Storefront', control: 'dropdown', options: [{ id: 'standard', label: 'Standard' }, { id: 'wide', label: 'Wide' }, { id: 'shallow', label: 'Shallow' }, { id: 'none', label: 'None' }], default: 'standard', blurb: 'Stepped back-right corner for New Releases. None = flat.' },
  { key: 'bb_walldecor', label: 'Wall Displays', section: 'Building & Storefront', control: 'checkbox', default: '0', blurb: 'Featured-actor portraits + film-strip ribbon, right wall. High ceiling only.' },
  { key: 'bb_wall_color', label: 'Wall Paint', section: 'Building & Storefront', control: 'dropdown', options: [{ id: 'auto', label: 'Match the era' }, { id: 'yellow', label: 'House Yellow' }, { id: 'parchment', label: 'Parchment' }, { id: 'white', label: 'White' }, { id: 'blue', label: 'Blue' }, { id: 'sage', label: 'Sage' }], default: 'auto', blurb: 'Wall paint tint. Theme Default follows the era.' },
  { key: 'bb_marquee_bulbs', label: 'Marquee Bulbs', section: 'Building & Storefront', control: 'checkbox', default: '1', blurb: 'Bulb rows on cornice + window posters. Off at Low quality.' },
  { key: 'bb_door_chime', label: 'Door Chime', section: 'Building & Storefront', control: 'dropdown', options: [{ id: 'recorded', label: 'Classic (Recording)' }, { id: 'electronic', label: 'Electronic Ding-Dong' }, { id: 'brass', label: 'Brass Bell' }, { id: 'glass', label: 'Glass Chime' }], default: 'recorded', blurb: 'The shop bell at the entrance.' },
  { key: 'bb_closed_mode', label: 'Closed Sign Screensaver', section: 'Building & Storefront', control: 'checkbox', default: '0', blurb: 'Idle screen shows SORRY — WE\'RE CLOSED instead of the bouncing tape.' },
  { key: 'bb_store_hours', label: 'Store Hours', section: 'Building & Storefront', control: 'text', default: '', blurb: 'Opening span "9:00-21:00" (24h). Outside it, the store dresses down. Blank = always open.' },
  { key: 'bb_clock_env', label: 'Environment Follows the Clock', section: 'Building & Storefront', control: 'checkbox', default: '0', blurb: 'Day 8-17, sunset 17-19, night otherwise (and while closed).' },
  { key: 'bb_carry_mode', label: 'Carry & checkout', section: 'How renting works', control: 'checkbox', default: '0', blurb: 'Carry a tape (OK), check out at the counter to play it.', warning: 'Every film must be carried to the counter and checked out first — about eight extra seconds before anything plays. This applies to every viewer.' },
  { key: 'bb_rental_mode', label: 'Rental mode (real lockout)', section: 'How renting works', control: 'checkbox', default: '0', warning: 'Titles lock for a real rental period after watching. Viewers cannot clear this themselves.' },
  { key: 'bb_games_enabled', label: 'Enable video game section', section: 'Departments', control: 'checkbox', default: '0', blurb: 'Adds a Video Games shelf stocked from Romm (or demo).' },
  { key: 'bb_games_only', label: 'Video games only', section: 'Departments', control: 'checkbox', default: '0', blurb: 'The whole store becomes the game store — every game in your Romm library, no movies.', warning: 'Hides every film. The store becomes games only, for everyone.' },
  { key: 'bb_streaming_enabled', label: 'Streaming-service sections', section: 'Departments', control: 'checkbox', default: '1', blurb: 'Shelve watch-provider titles per streaming service. Movies only. Off = no streaming aisles built.' },
  { key: 'bb_streaming_services', label: 'Streaming services', section: 'Departments', control: 'text', default: 'isDemoMode ? ALL_DEFAULT_STREAMING_SERVICES_CSV : ', blurb: 'Comma list of CHOSEN streaming services (Netflix, Prime Video, Disney+, Hulu, Max, Apple TV+, Paramount+, Peacock). Movies only. Blank = none. Easier: tick them off at the counter terminal — STREAMING SERVICES.' },
  { key: 'candy_delivery_enabled', label: 'Candy Delivery', section: 'Departments', control: 'checkbox', default: '0', blurb: 'Adds a "Snacks?" checkout step. Order opens in DoorDash.' },
  { key: 'bb_audio_lang', label: 'Preferred Audio Language', section: 'Playback', control: 'text', default: '', blurb: 'Track picked at start, e.g. "eng". Blank = file default.' },
  { key: 'bb_subtitles_default', label: 'Closed Captions On By Default', section: 'Playback', control: 'checkbox', default: '0', blurb: 'Start every movie with subtitles showing.' },
  { key: 'bb_case_art', label: 'Rental Case Art', section: 'Advanced', control: 'dropdown', options: [{ id: 'auto', label: 'Auto' }, { id: 'vhs', label: 'VHS Box' }, { id: 'dvd', label: 'DVD Box' }], default: 'auto', blurb: 'Force the VHS/DVD rental box design. Auto follows format.' },
  { key: 'bb_marquee_anim', label: 'Marquee Animation', section: 'Advanced', control: 'dropdown', options: [{ id: 'off', label: 'Unlit' }, { id: 'steady', label: 'Steady' }, { id: 'chase', label: 'Chase' }], default: 'steady', blurb: 'Chase never wakes the idle renderer by itself.' },
  { key: 'bb_overview_start', label: 'Start at entrance overview', section: 'Advanced', control: 'checkbox', default: '1', blurb: 'Start inside the doors on the jump index. Off = cam view.' },
  { key: 'bb_tonemap', label: 'Color Response', section: 'Advanced', control: 'dropdown', options: [{ id: 'neutral', label: 'True Color (PBR Neutral)' }, { id: 'agx', label: 'Filmic (AgX)' }], default: 'neutral', blurb: 'True Color keeps art as printed; Filmic softens highlights.' },
  { key: 'bb_grade_warmth', label: 'Color Warmth', section: 'Advanced', control: 'dropdown', options: [{ id: '0', label: 'Neutral' }, { id: '0.18', label: 'Subtle' }, { id: '0.35', label: 'Warm' }, { id: '0.7', label: 'Cozy' }], default: '0.35', blurb: 'Warm leans tungsten, like 90s film. Neutral is pure white.' },
  { key: 'bb_grade_lut', label: 'Film Look (LUT)', section: 'Advanced', control: 'checkbox', default: '0', blurb: 'Film-look grade: floated blacks, amber midtones. Free.' },
  { key: 'bb_brand_pack', label: 'Brand Pack', section: 'Advanced', control: 'text', default: '', warning: 'Naming a pack that is not installed degrades the store’s identity for every viewer, and this console cannot check it from here.' },
  { key: 'bb_platform_snes', label: 'Super Nintendo', section: 'Departments › Platforms', control: 'checkbox', default: '1' },
  { key: 'bb_platform_sfam', label: 'Super Famicom', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_nes', label: 'Nintendo NES', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_n64', label: 'Nintendo 64', section: 'Departments › Platforms', control: 'checkbox', default: '1' },
  { key: 'bb_platform_3ds', label: 'Nintendo 3DS', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_genesis', label: 'Sega Genesis', section: 'Departments › Platforms', control: 'checkbox', default: '1' },
  { key: 'bb_platform_psx', label: 'PlayStation', section: 'Departments › Platforms', control: 'checkbox', default: '1' },
  { key: 'bb_platform_ps2', label: 'PlayStation 2', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_gamecube', label: 'Nintendo GameCube', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_dreamcast', label: 'Sega Dreamcast', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_saturn', label: 'Sega Saturn', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_psp', label: 'PlayStation Portable', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_dsi', label: 'Nintendo DSi', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_switch', label: 'Nintendo Switch', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_wiiu', label: 'Wii U', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_xbox', label: 'Xbox', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_gba', label: 'Game Boy Advance', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_gbc', label: 'Game Boy Color', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_gb', label: 'Game Boy', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_arcade', label: 'Arcade', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
  { key: 'bb_platform_atari', label: 'Atari', section: 'Departments › Platforms', control: 'checkbox', default: '0' },
];

/**
 * Registered settings the console must NOT offer, each with the reason.
 *
 * The drift test requires every registered key to appear here or above, so
 * this is not documentation that can quietly go stale — it is the other half
 * of a total function over the registry.
 */
export const EXCLUDED_KEYS: Record<string, string> = {
  // ── Secrets. The console renders into HTML and the bootstrap writes into
  //    every viewer's localStorage; either is a disclosure.
  jellyfin_password: 'A password. Purged on every boot anyway, and Jellyfin-only on this fork.',
  jellyseerr_apikey: 'An API key. Broadcasting it hands every viewer a working Jellyseerr client.',
  tmdb_apikey: 'An API key, with no server-managed tier to fall back on.',
  romm_apikey: 'A literal username:password HTTP Basic credential (src/romm.ts:11).',

  // ── Internal addresses. Nothing outside the LAN should learn these, and the
  //    operator-managed server-side path already supplies them.
  jellyseerr_url: 'An internal hostname, and a no-op besides — seerr-config.ts returns null without it.',
  romm_url: 'An internal hostname, supplied operator-side.',
  jellyfin_url: 'Force-written per viewer by the front door already (plex-connection.ts).',
  jellyfin_username: 'Jellyfin-only, and gated off entirely while the provider is Plex.',

  // ── This device, not this shop. Enforcing any of these takes a viewer's
  //    phone or laptop and hands it the owner's TV settings.
  bb_quality: 'Auto-picked per GPU. Forcing one tier is the regression viewport.ts exists to avoid.',
  bb_ao: 'A cost/quality render tradeoff keyed to the local GPU.',
  bb_fps_cap: "Tied to the local display's refresh rate and the local GPU's supersample grant.",
  bb_fps_meter: "A diagnostic about this device's own frame time.",
  bb_perf_check: 'A diagnostic about this device (frame times, GPU, tier). The numbers are meaningless broadcast to other machines, and the hint is read live in the store drawer.',
  bb_local_mpv: 'Device-local by construction — main.ts only honours it on the server machine.',
  bb_remote_play: 'A dev/preview streaming feature; enforcing it would start it for everyone.',
  romm_launch_cmd: 'A shell command and a local emulator path. Tauri desktop only.',

  // ── Deferred, not rejected on principle.
  bb_store_format: 'Only one format exists (corporate). Revisit when a second lands.',
  bb_cover_vhs: 'Option ids come from video-case.ts, which the drift test cannot scan yet.',
  bb_cover_dvd: 'Same registration and the same scan problem as bb_cover_vhs.',
  bb_rental_dev: 'A developer timer that shortens the rental clock. Not a shop setting.',
  jellyseerr_suggest_from: 'Registered through the cred() helper, which the drift scan does not read yet.',
  jellyseerr_suggest_until: 'Registered through the cred() helper, which the drift scan does not read yet.',
};

/**
 * Keys the settings map may never contain, whatever the catalog says.
 *
 * The front door writes these itself in the same payload, and they carry the
 * viewer's Plex connection and the flag that strips the store down to a
 * viewer's menu. A settings map able to name them could hand every viewer a
 * different server, or switch viewer mode off for everybody.
 *
 * Belt AND braces: policyKeys() also spreads the settings map FIRST so the
 * dedicated fields win a collision on their own. This refuses the write.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'bb_viewer_only',
  'media_sources',
  'provider_kind',
  'jellyfin_url',
  'jellyfin_token',
  'jellyfin_userid',
  'plex_user_id',
]);

const BY_KEY = new Map(CONSOLE_SETTINGS.map((s) => [s.key, s]));

/** The catalog entry for a key, if the console offers it at all. */
export function consoleSetting(key: string): ConsoleSetting | undefined {
  return BY_KEY.get(key);
}

export interface ValidationResult {
  /** Only the entries that survived. Safe to persist and to broadcast. */
  settings: Record<string, string>;
  /** One line per rejection, for the console to show the owner. */
  errors: string[];
}

/**
 * Filter a submitted settings map down to what the console is allowed to set.
 *
 * REFUSES rather than coerces, and reports rather than silently dropping: an
 * owner who typos a theme id must be told, not left reloading the store and
 * wondering. The one exception is a checkbox, where '1'/'0' is the wire format
 * and anything truthy-looking is normalised — a checkbox cannot carry an
 * "invalid" value in the way a dropdown can.
 */
export function validateSettings(input: unknown): ValidationResult {
  const settings: Record<string, string> = {};
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { settings, errors: input === undefined ? [] : ['Settings must be an object.'] };
  }
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(key)) {
      errors.push(`${key} is reserved by the front door and cannot be set here.`);
      continue;
    }
    const def = BY_KEY.get(key);
    if (!def) {
      errors.push(`${key} is not a setting this console manages.`);
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'boolean' && typeof raw !== 'number') {
      errors.push(`${def.label} was sent as something other than a value.`);
      continue;
    }
    const value = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw);
    if (def.control === 'checkbox') {
      settings[key] = value === '1' || value === 'true' ? '1' : '0';
      continue;
    }
    if (def.control === 'dropdown') {
      if (!def.options?.some((o) => o.id === value)) {
        errors.push(`${def.label}: "${value}" is not one of its options.`);
        continue;
      }
      settings[key] = value;
      continue;
    }
    // Free text. Length-capped because it rides into an inline <script> on
    // every document load; the escaping in plex-connection.ts handles the
    // shape, this handles the size.
    if (value.length > 500) {
      errors.push(`${def.label} is too long (500 characters max).`);
      continue;
    }
    settings[key] = value;
  }
  return { settings, errors };
}
