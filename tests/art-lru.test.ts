// The decoded-art cache that replaced three Maps nothing ever cleared.
//
//   npm run test:artlru

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ArtLru } from '../src/art-lru.ts';

const MiB = 1024 * 1024;
type Art = { width: number; height: number };
const bytes = (a: Art) => a.width * a.height * 4;
const BACKDROP = 640 * 360 * 4; // 0.88 MiB, the shelf backdrop
const backdrop = (): Art => ({ width: 640, height: 360 });

test('browsing the whole catalog no longer grows memory without bound', () => {
  // THE LEAK. Every centred title used to leave its backdrop behind for good:
  // 2,174 of them is ~1.9 GB.
  const c = new ArtLru<Art>(96 * MiB, bytes);
  for (let i = 0; i < 2174; i++) c.set(`title-${i}`, backdrop());
  assert.ok(c.byteSize <= 96 * MiB, `${(c.byteSize / MiB).toFixed(1)} MiB over a 96 MiB budget`);
  assert.equal(c.size, Math.floor((96 * MiB) / BACKDROP));
});

test('the least recently used art goes first', () => {
  const c = new ArtLru<Art>(BACKDROP * 3, bytes);
  c.set('a', backdrop()); c.set('b', backdrop()); c.set('c', backdrop());
  c.get('a');             // touched, so now the newest
  c.set('d', backdrop()); // over budget by one: the oldest, b, must go
  assert.equal(c.has('b'), false, 'b was least recently used');
  assert.equal(c.has('a'), true, 'a was read, so it stays');
  assert.equal(c.has('c'), true);
  assert.equal(c.has('d'), true);
});

test('a stored null is a value, and a missing key is undefined', () => {
  // The read sites branch on exactly this: undefined means load it, null means
  // there is no art to load.
  const c = new ArtLru<Art | null>(MiB, bytes);
  c.set('episode-without-a-still', null);
  assert.equal(c.has('episode-without-a-still'), true);
  assert.equal(c.get('episode-without-a-still'), null);
  assert.equal(c.get('never-seen'), undefined);
});

test('an evicted entry reads as missing, so the caller reloads it', () => {
  const c = new ArtLru<Art>(BACKDROP, bytes);
  c.set('first', backdrop());
  c.set('second', backdrop());
  assert.equal(c.get('first'), undefined);
});

test('replacing an entry does not count its bytes twice', () => {
  const c = new ArtLru<Art>(100 * MiB, bytes);
  c.set('a', backdrop());
  c.set('a', backdrop());
  assert.equal(c.byteSize, BACKDROP);
});

test('one piece of art bigger than the whole budget is still kept', () => {
  // Otherwise it would refetch on every single draw.
  const c = new ArtLru<Art>(MiB, bytes);
  c.set('huge', { width: 4096, height: 4096 });
  assert.equal(c.has('huge'), true);
});

test('a flood of no-art markers is bounded too', () => {
  const c = new ArtLru<Art | null>(64 * 100, bytes);
  for (let i = 0; i < 10_000; i++) c.set(`ep-${i}`, null);
  assert.ok(c.size <= 100, `${c.size} null markers kept`);
});

const VC = readFileSync(new URL('../src/video-case.ts', import.meta.url), 'utf8');

test('all three decoded-art caches are bounded, not plain Maps', () => {
  for (const name of ['backdropImageCache', 'episodeThumbCache', 'seasonThumbCache']) {
    assert.match(VC, new RegExp(`const ${name} = new ArtLru<`), `${name} is not an ArtLru`);
    assert.doesNotMatch(VC, new RegExp(`const ${name} = new Map<`), `${name} is a plain Map again`);
  }
});

test('eviction never closes a bitmap something may still draw', () => {
  // A closed ImageBitmap throws on its next drawImage.
  const code = readFileSync(new URL('../src/art-lru.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.close\(/);
});
