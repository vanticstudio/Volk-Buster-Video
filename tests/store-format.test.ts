// GH #33: the store FORMAT preset system.
//
// Two things are pinned here, and the first matters more than the second.
//
// 1. THE CORPORATE FORMAT IS THE STATUS QUO, VALUE FOR VALUE. store-layout.ts
//    now derives most of its exported geometry from the active format instead
//    of stating literals, so the whole design rests on the claim that the
//    default preset reproduces exactly what those literals were. If that drifts,
//    every existing store silently changes shape, and nothing else in the suite
//    would catch a one-foot change to an aisle pitch. The expected values below
//    are transcribed from the constants as they stood before the refactor —
//    they are deliberately duplicated here rather than imported, because a test
//    that reads the same source as the code under test proves nothing.
//
// 2. (Removed with the mom-and-pop preset — see below.)
//    with each other and with the fixtures that stand in the space they leave,
//    which is the class of bug you cannot see in a screenshot until you are
//    already standing in the wrong place.
//
// Runs under plain `node --test` with type stripping — store-format.ts imports
// nothing at runtime and guards its one localStorage read, so it loads in node:
//
//   node --experimental-strip-types --test tests/store-format.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_FORMATS, DEFAULT_STORE_FORMAT, resolveStoreFormatId, activeStoreFormat,
} from '../src/store-format.ts';
import {
  AISLE_SHELF_HEIGHTS, UNIT_SIDE_CAPACITY, UNIT_CAPACITY, SECTION_CAPACITY,
  CENTER_WALKWAY, LIBRARY_X_SPACING, FIELD_Z_FRONT, CEILING_Y, MAX_RUN_UNITS,
  RUN_BREAK_GAP, UNIT_FRAME_HEIGHT, UNIT_DEPTH, MAX_SHELF_COLS, SECTION_COLS,
  FRONT_WINDOW_CORNER_MARGIN, vestibuleHalfWidth,
  unitDepthAtHeight,
} from '../src/store-layout.ts';

const corporate = STORE_FORMATS['corporate'];

// ── 1. The default store has not moved ──────────────────────────────────────

test('node (no localStorage) resolves to the corporate format', () => {
  assert.equal(DEFAULT_STORE_FORMAT, 'corporate');
  assert.equal(activeStoreFormat().id, 'corporate');
});


test('corporate preset reproduces the pre-format literals exactly', () => {
  assert.deepEqual(corporate.aisleShelfHeights, [0.5, 1.333, 2.167, 3.0, 3.833]);
  assert.equal(corporate.unitSections, 2);
  assert.equal(corporate.unitFrameHeight, 4.6);
  assert.equal(corporate.unitTaper, true);
  assert.equal(corporate.centerWalkway, 16.0);
  assert.equal(corporate.runSpacing, 11.0);
  assert.equal(corporate.runBreakGap, 3.0);
  assert.equal(corporate.fieldZFront, -14.4);
  assert.equal(corporate.wallMargin, 7.5);
  assert.equal(corporate.backAisleClearance, 8.0);
  assert.equal(corporate.baseRunUnits, 4);
  assert.equal(corporate.maxRunUnitsCap, 6);
  assert.equal(corporate.runGrowthPerUnits, 16);
  assert.equal(corporate.widthCap, 110.0);
  assert.equal(corporate.depthToWidthRatio, 0.9);
  assert.equal(corporate.ceilingY, 13.5);
  assert.equal(corporate.frontPanesBaseline, 16);
  assert.equal(corporate.sidePanesBaseline, 6);
  assert.equal(corporate.vestibuleInnerWidth, 9.0);
  assert.equal(corporate.doorWidth, 3.2);
  assert.equal(corporate.counterShape, 'shield');
  assert.equal(corporate.entryStyle, 'vestibule');
  assert.equal(corporate.frontCornerMargin, 2.25);
  assert.equal(corporate.facadeStyle, 'chain-tower');
  assert.equal(corporate.counterTv, false);
  assert.equal(corporate.browseStandoff, 3.8);
  assert.equal(corporate.keyLightSpacingScale, 1.0);
  assert.equal(corporate.keyLightIntensityScale, 1.0);
});

test('store-layout exports still carry the corporate literals', () => {
  // The derived constants are the dangerous ones: a dozen modules capture them
  // at import time, so a wrong tier count here mis-stocks the whole store.
  assert.deepEqual([...AISLE_SHELF_HEIGHTS], [0.5, 1.333, 2.167, 3.0, 3.833]);
  assert.equal(UNIT_SIDE_CAPACITY, 60);   // 12 cols x 5 tiers
  assert.equal(UNIT_CAPACITY, 120);       // double-sided
  assert.equal(SECTION_CAPACITY, 30);     // 6 cols x 5 tiers
  assert.equal(CENTER_WALKWAY, 16.0);
  assert.equal(LIBRARY_X_SPACING, 11.0);
  assert.equal(FIELD_Z_FRONT, -14.4);
  assert.equal(CEILING_Y, 13.5);
  assert.equal(MAX_RUN_UNITS, 4);
  assert.equal(RUN_BREAK_GAP, 3.0);
  assert.equal(UNIT_FRAME_HEIGHT, 4.6);
  assert.equal(MAX_SHELF_COLS, 12);   // 6-col sections x 2
  assert.equal(FRONT_WINDOW_CORNER_MARGIN, 2.25);
});

test('the corporate gondola still tapers with height', () => {
  assert.equal(unitDepthAtHeight(0), UNIT_DEPTH);
  assert.ok(unitDepthAtHeight(3.833) < UNIT_DEPTH, 'top tier must be shallower than the base');
});

// ── 2. Only one format remains ──────────────────────────────────────────────
//
// Upstream carried a second preset, mom-and-pop, and most of this file existed
// to prove that preset's numbers were internally coherent — its tighter runs
// still fit a camera, its taller shelving still cleared the ceiling, its
// standalone desk still held what stood on it. That format was removed on
// request, so those tests went with it: they asserted things about geometry
// that no longer exists.
//
// What survives is the part that is still true and still worth pinning: the
// corporate box's own coherence, and the resolver's fail-safe behaviour.

test('every format supplies every field the spec declares', () => {
  // Cheap structural guard: a new field added to StoreFormatSpec and filled in
  // on only one preset is a TypeScript error, but a field left `undefined` by a
  // sloppy object spread is not — and an undefined geometry number propagates
  // as NaN into the floor plan, which builds a store with no shelves in it.
  for (const f of Object.values(STORE_FORMATS)) {
    for (const [k, v] of Object.entries(f)) {
      assert.notEqual(v, undefined, `${f.id}.${k} is undefined`);
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `${f.id}.${k} is not finite`);
      }
    }
  }
});













// ── The resolver still fails safe ───────────────────────────────────────────

test('any unknown, absent or malformed saved value resolves to the one format', () => {
  // This matters more now than it did with two formats, not less. bb_store_format
  // may still hold 'mom-and-pop' in a browser that ran an older build, and the
  // resolver is the only thing standing between that stale value and an
  // undefined lookup in STORE_FORMATS.
  for (const bad of ['mom-and-pop', 'corporate-xl', '', '  ', 'null', 'undefined']) {
    assert.equal(resolveStoreFormatId(bad), 'corporate', `${JSON.stringify(bad)} must resolve`);
  }
  for (const bad of [null, undefined, 0, 1, {}, [], true]) {
    assert.equal(resolveStoreFormatId(bad), 'corporate');
  }
  assert.equal(resolveStoreFormatId('corporate'), 'corporate');
});

test('the registry holds exactly the formats the type admits', () => {
  // A guard against the two drifting: adding a preset without widening
  // StoreFormatId (or the reverse) is how a format becomes unreachable.
  assert.deepEqual(Object.keys(STORE_FORMATS), ['corporate']);
  assert.equal(STORE_FORMATS[DEFAULT_STORE_FORMAT], corporate);
});
