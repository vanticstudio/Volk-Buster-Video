/**
 * Session tokens — the cookie that says "this browser already passed the gate".
 *
 * The Plex gate (plex-gate.ts) runs once, at sign-in, because verifying access
 * costs a round trip to plex.tv and cannot happen on every request. Everything
 * afterwards trusts this token instead — which makes forging one exactly
 * equivalent to bypassing the gate, and is why this module is written
 * adversarially and tested that way (tests/sessions.test.ts).
 *
 * FORMAT: `base64url(json) . base64url(hmac-sha256(json, secret))`
 *
 * The payload is signed, not encrypted, and that is deliberate. It holds an
 * account id, a boolean and an expiry — nothing secret. The viewer's actual
 * Plex token never travels in a cookie; it stays server-side, encrypted at
 * rest, and is handed to an instance over loopback via a one-time ticket.
 *
 * WHY `owner` IS SIGNED RATHER THAN LOOKED UP: it gates brand, connection and
 * the setup terminal, so flipping it is a straight privilege escalation from
 * guest to admin. Signing it alongside the identity means a tampered flag
 * invalidates the whole token rather than quietly granting access. The cost is
 * that revoking ownership needs the session to expire — bounded by exp, and by
 * the periodic re-validation against plex.tv the front door performs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** Server-side session id — the key for the stored Plex token. */
  sid: string;
  /** Plex account id this session belongs to. */
  uid: string;
  /** True only for the account Plex reports as owning this server. */
  owner: boolean;
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
}

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Mint a signed session token. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

/**
 * Verify a token and return its payload, or null.
 *
 * NEVER THROWS. A request handler passes whatever arrived in a cookie header
 * straight in; if this threw on malformed input, anyone could take the server
 * down by sending a bad cookie. Every failure — bad shape, bad signature, bad
 * JSON, missing field, expired — is the same `null`, so nothing about *why* a
 * token was refused leaks back to whoever sent it.
 *
 * `now` is injected rather than read from the clock so expiry is testable
 * without waiting, and so a single request can't straddle a tick.
 */
export function verifySession(token: string, secret: string, now: number): SessionPayload | null {
  try {
    if (typeof token !== 'string') return null;

    // Exactly two parts. `a.b.c` is a different format (a JWT, say) and must be
    // refused outright rather than partially parsed.
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    if (!body || !signature) return null;

    // Constant-time comparison. A byte-by-byte early exit leaks, through timing,
    // how much of a guessed signature was correct — which turns forging one from
    // infeasible into a few thousand requests. timingSafeEqual throws on a length
    // mismatch, so compare lengths first (a length difference reveals nothing an
    // attacker doesn't already know, since the format is public).
    const expected = Buffer.from(hmac(body, secret));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;

    // Validate the SHAPE even though the signature already proved we minted it.
    // A token signed by an older build with a different payload is authentic and
    // still not something this build understands, and `owner` defaulting to
    // undefined would read as falsy in some places and be absent in others.
    if (typeof p.sid !== 'string' || !p.sid) return null;
    if (typeof p.uid !== 'string' || !p.uid) return null;
    if (typeof p.owner !== 'boolean') return null;
    if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null;

    // Expiry is inclusive of its own instant: a session minted for exactly `now`
    // is still valid at `now`.
    if (now > p.exp) return null;

    return { sid: p.sid, uid: p.uid, owner: p.owner, exp: p.exp };
  } catch {
    return null;
  }
}
