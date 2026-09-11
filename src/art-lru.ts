// A byte-bounded, Map-compatible cache for decoded cover art.
//
// Zero imports so tests/art-lru.test.ts can load it under `node --test`.

/**
 * WHY THIS EXISTS. video-case.ts kept backdrops, episode stills and season
 * posters in plain Maps that nothing ever cleared. Every title the browse
 * cursor centred left a decoded 640x360 backdrop behind — 0.88 MiB each — for
 * the rest of the session, and the file's own comment admitted it:
 * "backdropImageCache is unbounded ... a cache that already grows with the
 * session". Across a 2,174-title catalog that is ~1.9 GB, and it grows exactly
 * while someone is browsing, which is when the machine was reported slowing.
 *
 * MAP-COMPATIBLE on the three calls the read sites use — has, get and set — so
 * none of them had to change. They already treat a missing entry as "load it",
 * which is what makes eviction safe at all.
 *
 * `undefined` MEANS MISSING; `null` IS A VALUE. The thumbnail caches store null
 * for "this episode has no still", so a redraw does not refetch it every frame.
 * Map keeps those apart, and so does this.
 *
 * EVICTION DOES NOT CALL close(). An ImageBitmap closed while something still
 * holds it throws on its next draw. The analysis caches keyed by these bitmaps
 * are WeakMaps, so dropping an entry here removes the last strong reference and
 * the decoded pixels go with the next collection — slower than closing them,
 * and impossible to turn into a use-after-close.
 */

/** So a flood of "no art" markers cannot grow without bound either. */
const NULL_ENTRY_BYTES = 64;

export class ArtLru<V> {
  private readonly entries = new Map<string, V>();
  private readonly costs = new Map<string, number>();
  private readonly budgetBytes: number;
  private readonly sizeOf: (value: NonNullable<V>) => number;
  private bytes = 0;

  constructor(budgetBytes: number, sizeOf: (value: NonNullable<V>) => number) {
    this.budgetBytes = budgetBytes;
    this.sizeOf = sizeOf;
  }

  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    // Re-insert: a Map iterates in insertion order, so this makes it the newest.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): this {
    if (this.entries.has(key)) {
      this.bytes -= this.costs.get(key) ?? 0;
      this.entries.delete(key);
    }
    const cost = value == null
      ? NULL_ENTRY_BYTES
      : Math.max(0, this.sizeOf(value as NonNullable<V>) || 0);
    this.entries.set(key, value);
    this.costs.set(key, cost);
    this.bytes += cost;
    this.evictOldest(key);
    return this;
  }

  private evictOldest(justSet: string): void {
    for (const key of [...this.entries.keys()]) {
      if (this.bytes <= this.budgetBytes) return;
      // Never the entry just stored: one oversized piece of art must still be
      // cacheable, or it would refetch on every draw.
      if (key === justSet) continue;
      this.bytes -= this.costs.get(key) ?? 0;
      this.costs.delete(key);
      this.entries.delete(key);
    }
  }
}
