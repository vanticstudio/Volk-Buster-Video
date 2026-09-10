// #77 — the counter CRT silently truncated its menu: drawTerminal's body box
// seats ~10 rows at the default pitch and the manager ring was 12, so the two
// bottom rows (MANAGER OVERRIDE, RETURN TO STORE) were slice()d away with no
// trace. (This fork removed SWITCH TO 2D MODE along with 2.5D mode itself, so
// the ring is one row shorter than upstream's and now carries one slot of
// spare headroom — see the ceiling tripwire at the bottom of this file.) fitTerminalPitch is the fix's pure core; these tests pin it against
// the REAL geometry drawTerminal derives from the shared 1024x768 terminal
// canvas, and against the real ring lengths from counterTerminalLines.
//
//   npm run test:terminal

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTER_TERMINAL_LABELS,
  VIEWER_TERMINAL_ROWS,
  counterTerminalLines,
  counterTerminalRows,
  fitTerminalPitch,
} from '../src/counter-terminal.ts';

// Mirror of drawTerminal's derivation (entrance/index.ts) for its 1024x768
// canvas — if the geometry there changes, re-derive these.
const W = 1024, H = 768;
const PAD_X = W * 0.155;
const SAFE_W = W - PAD_X * 2;
const CH = SAFE_W / 40;
const FONT_PX = Math.floor(CH / 0.6);
const LINE_H = Math.round(FONT_PX * 1.24);
const PAD_Y = H * 0.12;
const BODY_TOP = PAD_Y + LINE_H * 2;
const FOOT_TOP = Math.round(H * 0.73);
const BODY_SPAN = FOOT_TOP - BODY_TOP;

test('idle screen keeps the default pitch', () => {
  const { lineH, maxLines } = fitTerminalPitch(9, LINE_H, FONT_PX, BODY_SPAN);
  assert.equal(lineH, LINE_H);
  assert.ok(maxLines >= 9);
});

test('the full manager ring seats without clipping (#77)', () => {
  const ids = counterTerminalRows(false);
  assert.equal(ids.length, 10); // full ring incl. the three CRT-only rows
  const { lines, cursorLine } = counterTerminalLines(ids, ids.length - 1);
  assert.equal(lines.length, 12); // 2 header rows + 10 buttons
  assert.equal(lines[lines.length - 1], '> RETURN TO STORE');
  assert.equal(cursorLine, lines.length - 1);
  const { lineH, maxLines } = fitTerminalPitch(lines.length, LINE_H, FONT_PX, BODY_SPAN);
  assert.ok(maxLines >= lines.length, `only ${maxLines} of ${lines.length} rows fit`);
  assert.ok(lineH >= FONT_PX, 'pitch fell below 1.0 leading');
  // The compressed rows must still physically clear the footer's reserve.
  assert.ok(BODY_TOP + (lines.length + 0.4) * lineH <= FOOT_TOP + 1e-6);
});

test('the demo manager ring seats without clipping (#133)', () => {
  const ids = counterTerminalRows(true);
  assert.equal(ids.length, 9); // demo ring: logout/exit replaced by project link
  const { lines, cursorLine } = counterTerminalLines(ids, ids.length - 1);
  assert.equal(lines.length, 11); // 2 header rows + 9 buttons
  assert.equal(lines[lines.length - 1], '> RETURN TO STORE');
  assert.equal(cursorLine, lines.length - 1);
  const { lineH, maxLines } = fitTerminalPitch(lines.length, LINE_H, FONT_PX, BODY_SPAN);
  assert.ok(maxLines >= lines.length, `only ${maxLines} of ${lines.length} rows fit`);
  assert.ok(lineH >= FONT_PX, 'pitch fell below 1.0 leading');
  assert.ok(BODY_TOP + (lines.length + 0.4) * lineH <= FOOT_TOP + 1e-6);
});

// ─── Viewer mode ────────────────────────────────────────────────────────────
//
// The ring a store served through the front door draws. The public port sits
// behind a Cloudflare tunnel and is reachable by everyone the owner shared a
// Plex library with, so the CRT there must not offer rows that reconfigure the
// store or the machine — those moved to the management console on 3366.

test('the viewer ring offers only the basics', () => {
  // Pinned as an exact list, not a length: the failure this guards against is
  // a row being ADDED back, and a count assertion passes if one swaps for
  // another. Every id here must be a row a visitor can safely press.
  assert.deepEqual([...VIEWER_TERMINAL_ROWS], ['btn-controls', 'btn-signout', 'btn-cancel']);
});

test('no viewer row reconfigures the store or the machine', () => {
  // The specific rows that made this necessary. SUSPEND SYSTEM sleeps the
  // OWNER'S NAS; MANAGER OVERRIDE opens the staff knobs; CHANGE SERVER / LOG OUT
  // repoints the store's own Plex connection for whoever loads it next.
  for (const id of ['btn-settings', 'btn-service', 'btn-suspend', 'btn-cec-toggle',
    'btn-logout', 'btn-exit', 'btn-streaming', 'btn-media-date']) {
    assert.ok(!VIEWER_TERMINAL_ROWS.includes(id), `${id} must not be offered to a viewer`);
  }
});

test('SIGN OUT is offered ONLY in viewer mode', () => {
  // A directly-run store has no front-door session, so the row would be a dead
  // navigation to a route nothing serves.
  for (const demo of [false, true]) {
    assert.ok(!counterTerminalRows(demo).includes('btn-signout'));
  }
  assert.ok(VIEWER_TERMINAL_ROWS.includes('btn-signout'));
});

test('every viewer row has a CRT label', () => {
  // The ring is drawn by id; a missing label renders the raw id at the counter.
  for (const id of VIEWER_TERMINAL_ROWS) {
    assert.ok(COUNTER_TERMINAL_LABELS[id], `${id} has no label`);
  }
});

test('the viewer ring seats with room to spare', () => {
  const { lines } = counterTerminalLines([...VIEWER_TERMINAL_ROWS], 0);
  const { lineH, maxLines } = fitTerminalPitch(lines.length, LINE_H, FONT_PX, BODY_SPAN);
  assert.ok(maxLines >= lines.length);
  assert.equal(lineH, LINE_H, 'three rows must not need the tightened pitch');
});

// #96 put the manager ring on the CRT's physical ceiling: 13 lines seat only
// because fitTerminalPitch tightens to its 1.0-leading floor, and the 14th does
// not fit at any pitch. Removing SWITCH TO 2D MODE along with 2.5D mode handed
// one of those slots back, so the ring now sits ONE row below the ceiling.
//
// Both halves are asserted deliberately. The first pins the headroom that
// removal bought, so a future row lands on evidence rather than on hope; the
// second is the original tripwire, still the thing that must fail HERE, in CI,
// rather than at the CRT where drawTerminal would clip it behind a MORE marker.
test('the ring sits one row below its ceiling', () => {
  const ids = counterTerminalRows(false);

  const oneMore = counterTerminalLines([...ids, 'btn-hypothetical'], 0).lines;
  assert.ok(
    fitTerminalPitch(oneMore.length, LINE_H, FONT_PX, BODY_SPAN).maxLines >= oneMore.length,
    'the slot freed by removing 2D MODE no longer fits — re-derive this before adding a row',
  );

  const twoMore = counterTerminalLines([...ids, 'btn-hypothetical', 'btn-hypothetical-2'], 0).lines;
  assert.ok(
    fitTerminalPitch(twoMore.length, LINE_H, FONT_PX, BODY_SPAN).maxLines < twoMore.length,
    'a 12th manager row now fits — re-derive the ceiling comment before adding one',
  );
});

test('a list too long even at floor pitch reports a smaller maxLines', () => {
  const { lineH, maxLines } = fitTerminalPitch(20, LINE_H, FONT_PX, BODY_SPAN);
  assert.equal(lineH, FONT_PX);
  assert.ok(maxLines < 20);
  assert.ok(maxLines >= 1);
});

test('every CRT label obeys the 38-char clip contract', () => {
  for (const [id, label] of Object.entries(COUNTER_TERMINAL_LABELS)) {
    assert.ok(label.length <= 38, `${id} label is ${label.length} chars`);
  }
});
