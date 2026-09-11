// The poster mirror read that crashed once viewer mode freed the mirror.
//
// poster-textures.ts cannot load under node --test (three + extensionless
// specifiers), so the guard lives in a zero-import leaf and the wiring is checked
// by reading the source — the same technique tests/store-settings.test.ts uses.
//
//   npm run test:postermirror

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mirrorRangeReadable } from '../src/poster-mirror-read.ts';

const LAYER = 160 * 240 * 4; // 153,600 bytes — one high-res title

test('a released mirror is unreadable, not a TypeError', () => {
  // THE BUG. releaseMirrorIfUnused sets image.data to null in viewer mode, and
  // getFallbackPixels then read `.length` off it and threw.
  assert.equal(mirrorRangeReadable(null, 0, LAYER), false);
  assert.equal(mirrorRangeReadable(undefined, 0, LAYER), false);
});

test('an in-range layer is readable, and the byte past the end is not', () => {
  // An off-by-one here hands a hover the NEXT title's cover.
  const two = new Uint8Array(LAYER * 2);
  assert.equal(mirrorRangeReadable(two, 0, LAYER), true);
  assert.equal(mirrorRangeReadable(two, LAYER, LAYER), true, 'the last layer, flush to the end');
  assert.equal(mirrorRangeReadable(two, LAYER * 2, LAYER), false, 'one layer past the end');
  assert.equal(mirrorRangeReadable(two, LAYER + 1, LAYER), false, 'one byte past the end');
});

test('a negative offset is never readable', () => {
  // A first-bank title's low-res slot is negative on a two-bank catalog.
  assert.equal(mirrorRangeReadable(new Uint8Array(LAYER), -LAYER, LAYER), false);
});

const SRC = readFileSync(new URL('../src/poster-textures.ts', import.meta.url), 'utf8');

test('getFallbackPixels no longer reads .length off a possibly-null mirror', () => {
  assert.doesNotMatch(SRC, /<= \(data as Uint8Array\)\.length/,
    'an unguarded mirror length read is back');
  const fn = SRC.slice(SRC.indexOf('public getFallbackPixels'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.equal((body.match(/mirrorRangeReadable\(/g) || []).length, 2, 'both the atlas and the high-res reads are guarded');
});

test('the rebuild fast path refuses a released high-res mirror', () => {
  // Otherwise it sets needsUpdate and three uploads null into the new context.
  assert.match(SRC, /const haveArrays = !!\(this\.lowResArray && this\.highResArray\?\.image\?\.data &&/);
});

test('the release comment no longer claims nothing reads the mirror', () => {
  // That false claim is how the unguarded read was missed.
  assert.doesNotMatch(SRC, /after this call nothing reads it/);
  assert.doesNotMatch(SRC, /~351 MB/);
});
