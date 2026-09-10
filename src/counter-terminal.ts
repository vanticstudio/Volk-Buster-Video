// The clerk's desk terminal rendered as a system-control menu — the diegetic
// twin of the #power-menu-overlay glass card. Both views drive the SAME
// power-button ids and dispatch through main.ts's executePowerMenuAction(), so
// they can't drift apart; only the presentation differs.
//
// This module is the part the 3D harness also needs (it boots StoreScene
// without main.ts's DOM shell), so the row text lives here as pure data +
// a pure formatter rather than inside main.ts.
// Brand seam: the one branded row (CLOSE <BRAND> APP) reads through a late-
// bound resolver instead of importing brand-pack, which drags DOM-flavored
// modules behind it and would break this file's node-testability — the whole
// reason the row text lives here (see header). brand-pack.ts installs the
// real brandString at its module eval (it is loaded before any CRT draws);
// until then, and in node tests, the fallback literal is the answer — which
// is exactly brandString's own behavior with no pack loaded.
type BrandStringResolver = (key: string, fallback: string) => string;
let brandStringResolver: BrandStringResolver = (_key, fallback) => fallback;
export function setBrandStringResolver(fn: BrandStringResolver): void {
  brandStringResolver = fn;
}

export const PROJECT_PAGE_BUTTON_ID = 'btn-project';
export // Point this at YOUR fork before publishing — it is opened from the manager
// terminal's project row and shown on the demo's playback card.
const PROJECT_PAGE_URL = 'https://github.com/halcyon-video/halcyon-video';

// Short labels for the CRT. drawTerminal() in entrance/index.ts hard-clips each
// line at 40 characters, and the "> " selection prefix eats two of them, so
// every label here must stay within 38.
export const COUNTER_TERMINAL_LABELS: Record<string, string> = {
  'btn-settings': 'STORE SETTINGS',
  'btn-controls': 'CONTROLS & HELP',
  'btn-suspend': 'SUSPEND SYSTEM (SLEEP)',
  'btn-cec-toggle': 'DISPLAY ON/OFF (CEC)',
  // Standing route for the demo (#133): invites visitor to run their own store.
  'btn-project': 'RUN ON YOUR OWN SERVER (GITHUB)',
  'btn-logout': 'CHANGE SERVER / LOG OUT',
  // Lazy: this object is built at module eval, long before the brand pack
  // has loaded, so the one branded row reads through a getter.
  get 'btn-exit'() { return brandStringResolver('terminal-exit-label', 'CLOSE VOLKBUSTER APP'); },
  // CRT-only row (#96): the way back into the streaming-services picker the
  // opening-day terminal offers once and only once. A store that connected
  // its media server before that shipped never saw it, so this is the only
  // remote-driven route to the choice — the settings drawer's row is a typed
  // comma list, which is not a thing anyone does from a couch.
  'btn-streaming': 'STREAMING SERVICES (PICK APPS)',
  // CRT-only row (not in the glass power menu): the diegetic door into the
  // SERVICE MODE settings page — the staff knobs hidden from the couch tree.
  'btn-service': 'MANAGER OVERRIDE (STAFF ONLY)',
  // CRT-only row (#42): opens the BIOS-style date sub-screen that pins the
  // catalog to a rolling point in time (counter-terminal-flow.ts).
  'btn-media-date': 'MEDIA RELEASE DATE (PIN CATALOG)',
  // Signs out of the STORE FRONT, not out of Plex — the front door drops the
  // session and the viewer lands back on its sign-in page. Only offered when a
  // front door is actually in front (see VIEWER_TERMINAL_ROWS in main.ts);
  // a directly-run store has no session to end.
  'btn-signout': 'SIGN OUT',
  'btn-cancel': 'RETURN TO STORE',
};

// ─── The rings ───────────────────────────────────────────────────────────────
//
// WHICH ROWS EACH MENU CARRIES, as pure data next to the labels they resolve
// through. This lived in main.ts, where the CRT ceiling test could only reach
// it by enumerating COUNTER_TERMINAL_LABELS and subtracting the rows it knew
// were conditional — a proxy that silently mis-measured the ring the moment a
// label existed that no ring carried. Here the test pins the real arrays.
//
// `demo` is passed in rather than imported: demo-mode.ts reads the DOM, and
// this module stays node-testable (see the header).

/** The glass power-menu overlay, and the base the CRT ring extends. */
export function powerMenuRows(demo: boolean): string[] {
  // Demo mode replaces the unusable logout/exit rows with the standing project
  // route (#133) — there is no server to change and no app to close.
  return demo
    ? ['btn-settings', 'btn-controls', 'btn-suspend', 'btn-cec-toggle', PROJECT_PAGE_BUTTON_ID, 'btn-cancel']
    : ['btn-settings', 'btn-controls', 'btn-suspend', 'btn-cec-toggle', 'btn-logout', 'btn-exit', 'btn-cancel'];
}

/**
 * The counter CRT's ring: the glass rows plus the three the CRT alone carries —
 * STREAMING SERVICES (#96), MEDIA RELEASE DATE (#42) and MANAGER OVERRIDE, the
 * only couch-reachable door into SERVICE MODE. Inserted above RETURN TO STORE
 * so the safe exit stays last.
 *
 * At the CRT's physical ceiling minus one row: 11 lines (2 header + 9) seat
 * only because fitTerminalPitch tightens to its 1.0-leading floor, and removing
 * 2.5D mode handed back exactly one slot. A new row from here wants a
 * sub-screen to live under, not a place in this list —
 * tests/counter-terminal.test.ts fails first, on purpose.
 */
export function counterTerminalRows(demo: boolean): string[] {
  const ids = powerMenuRows(demo);
  ids.splice(ids.indexOf('btn-cancel'), 0, 'btn-streaming', 'btn-media-date', 'btn-service');
  return ids;
}

/**
 * VIEWER MODE — what a store served through a front door offers.
 *
 * The public port is reachable by everyone the owner shared a Plex library
 * with, and every administrative control now lives on the management console
 * instead. So the store keeps what a VISITOR needs — the controls reference and
 * the way out — and drops the rest.
 *
 * Not a security boundary and not pretending to be one: the removed rows change
 * the machine and the store's own configuration, neither of which the front
 * door takes instructions about. This is about not offering a viewer a menu
 * full of things that are not theirs, one of which suspends the owner's NAS.
 *
 * CONTROLS & HELP WAS HERE AND HAD TO GO. It looked harmless — a reference
 * card, no knobs — but it opens the settings drawer on its Controls page, and
 * Back from any page sets settingsPage = null, which regenerates the drawer as
 * the full category index: Store Look, Connection, Performance, the lot. One
 * ESC from a help screen was the whole store's settings. The rows below are now
 * the only two, and openSettingsDrawer() refuses outright in viewer mode so a
 * future row cannot reopen the same door by accident.
 */
export const VIEWER_TERMINAL_ROWS: readonly string[] = ['btn-signout', 'btn-cancel'];

// Body lines the header sits above (drawTerminal draws its own
// "<BRAND> RENTAL SYSTEM" banner), plus where to park the blinking cursor.
// `ids` is the caller's live button list so demo mode's shorter ring renders
// correctly without this module knowing about demo mode.
export function counterTerminalLines(ids: string[], selectedIndex: number): {
  lines: string[];
  cursorLine: number;
} {
  const lines = ['MANAGER TERMINAL — SYSTEM CONTROL', ''];
  ids.forEach((id, idx) => {
    lines.push(`${idx === selectedIndex ? '>' : ' '} ${COUNTER_TERMINAL_LABELS[id] ?? id}`);
  });
  // Two header rows precede the options, so the cursor tracks the selection.
  return { lines, cursorLine: 2 + selectedIndex };
}

// #77: drawTerminal (entrance/index.ts) seats the body between the title bar
// and the pinned footer — ~10 rows at the default 1.24 leading — and the
// manager menu's full ring is 12 rows. Its old maxLines slice() dropped the
// overflow silently, so MANAGER OVERRIDE and RETURN TO STORE simply never
// rendered. This picks the row pitch instead: the default when everything
// fits, else tightened toward 1.0 leading (fontPx — authentic text-mode
// density) so the whole list seats before anything is clipped. maxLines
// still comes back for the caller's loud-clip path (a list too long even at
// the floor pitch). Pure math so the node tests can pin the real 1024x768
// geometry against the real ring lengths.
export function fitTerminalPitch(
  lineCount: number,
  defaultLineH: number,
  fontPx: number,
  bodySpan: number,
): { lineH: number; maxLines: number } {
  let lineH = defaultLineH;
  if ((lineCount + 0.4) * lineH > bodySpan) {
    lineH = Math.max(fontPx, Math.floor(bodySpan / (lineCount + 0.4)));
  }
  const maxLines = Math.max(1, Math.floor(bodySpan / lineH - 0.4));
  return { lineH, maxLines };
}

// #60: the poster-layer budget (two DataArrayTexture banks — see
// poster-textures.ts's POSTER_BANKS note) is a hard driver ceiling. A catalog
// past it used to shelve titles with no cover art and no explanation — the
// only signal was a console.warn nobody reads. This is the plain-language
// version, for the idle CRT screen (entrance/index.ts's drawTerminal): a
// pure formatter, like counterTerminalLines above, so it stays testable and
// the harness can render it without booting main.ts. Returns [] when there
// is no shortfall — a diagnostic that shows a scary number on every healthy
// install is worse than the silence it replaced, so the caller should only
// splice this in when it's non-empty.
export function posterShortfallLines(shortfall: number, layerBudget: number): string[] {
  if (shortfall <= 0) return [];
  return [
    `NOTICE: ${shortfall} TITLES HAVE NO COVER ART`,
    `(YOUR GPU CAPS COVERS AT ${layerBudget} TITLES)`,
  ];
}
