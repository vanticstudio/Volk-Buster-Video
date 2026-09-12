/**
 * A per-caller sliding-window rate limit, shared by the front door and the
 * management console.
 *
 * The caller is keyed by `callerKey()` (server/index.ts), which is why the
 * limiter itself knows nothing about IP headers: the trust decision about
 * CF-Connecting-IP lives in exactly one place. Both classes of caller this
 * serves are unauthenticated — pin registration and pin claiming — so the
 * limit is the only thing standing between a stranger and an endpoint that
 * writes shared state or reaches out to plex.tv.
 *
 * In memory rather than a store on purpose: a rate limit that outlives a
 * restart protects nothing (the attacker also restarted), and a restart is
 * the one event that legitimately resets everyone's budget.
 */
export class RateLimiter {
  private hits: Map<string, number[]>;
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxKeys: number;

  constructor(
    windowMs: number,
    max: number,
    /** Upper bound on tracked callers, so a long-lived process cannot be
     *  inflated into a memory exhaustion target by varying the key. */
    maxKeys = 5000,
  ) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /**
   * Record one hit. True when the caller is over the limit for this window.
   *
   * Every call counts, including ones answered 400 — a limiter that only
   * counted successful requests would let a stranger probe at full speed and
   * only ever slow down once they started succeeding.
   */
  limited(key: string, at: number): boolean {
    const hits = (this.hits.get(key) || []).filter((t) => at - t < this.windowMs);
    hits.push(at);
    this.hits.set(key, hits);
    if (this.hits.size > this.maxKeys) this.sweep(at);
    return hits.length > this.max;
  }

  /** Drop windows that have slid past, keeping the map bounded. */
  sweep(at: number): void {
    for (const [k, v] of this.hits) {
      if (!v.some((t) => at - t < this.windowMs)) this.hits.delete(k);
    }
  }
}
