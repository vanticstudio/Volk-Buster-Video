// The store-hours arithmetic. The interesting cases are the midnight-crossing
// span (a video store open until 2am) and the half-open interval (closing
// hour is not open). See src/store-hours.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStoreHours,
  storeIsOpenAtHour,
  outsideModeForHour,
  type StoreHoursSpec,
} from '../src/store-hours.ts';

test('parses the 24h span forms owners will type', () => {
  assert.deepEqual(parseStoreHours('9:00-21:00'), { openHour: 9, closeHour: 21 });
  assert.deepEqual(parseStoreHours('9-21'), { openHour: 9, closeHour: 21 });
  assert.deepEqual(parseStoreHours(' 20:00-02:00 '), { openHour: 20, closeHour: 2 });
  assert.deepEqual(parseStoreHours('10-24'), { openHour: 10, closeHour: 0 });
});

test('garbage and absent specs are not configured', () => {
  assert.equal(parseStoreHours(null), null);
  assert.equal(parseStoreHours(''), null);
  assert.equal(parseStoreHours('9am-5pm'), null);
  assert.equal(parseStoreHours('21-9x'), null);
  assert.equal(parseStoreHours('9-25'), null);
  assert.equal(parseStoreHours('9-9'), null, 'a zero-length span is a typo, not a 24h store');
});

function span(o: number, c: number): StoreHoursSpec {
  return { openHour: o, closeHour: c };
}

test('an open span crosses its closing hour at the boundary', () => {
  const s = span(9, 21);
  assert.equal(storeIsOpenAtHour(9, s), true, 'open hour is open');
  assert.equal(storeIsOpenAtHour(20, s), true);
  assert.equal(storeIsOpenAtHour(21, s), false, 'the close hour is closed (half-open interval)');
  assert.equal(storeIsOpenAtHour(8, s), false);
});

test('a midnight-crossing span is open either side of 24:00', () => {
  const s = span(20, 2);
  assert.equal(storeIsOpenAtHour(20, s), true);
  assert.equal(storeIsOpenAtHour(23, s), true);
  assert.equal(storeIsOpenAtHour(0, s), true);
  assert.equal(storeIsOpenAtHour(1, s), true);
  assert.equal(storeIsOpenAtHour(2, s), false);
  assert.equal(storeIsOpenAtHour(15, s), false);
});

test('the sky matches the manual outside cycle vocabulary', () => {
  assert.equal(outsideModeForHour(12), 'day');
  assert.equal(outsideModeForHour(16), 'day');
  assert.equal(outsideModeForHour(17), 'sunset');
  assert.equal(outsideModeForHour(18), 'sunset');
  assert.equal(outsideModeForHour(19), 'night');
  assert.equal(outsideModeForHour(3), 'night');
});