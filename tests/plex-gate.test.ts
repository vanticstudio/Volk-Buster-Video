// The access gate — who is allowed into this store.
//
// This is the whole security model of the fork in one function. The store is
// reachable on the public internet through a Cloudflare Tunnel, and the ONLY
// thing standing between a stranger and someone's media library is
// `grantsAccessTo`. It is deliberately pure so it can be tested exhaustively
// with no network, no browser and no Plex account.
//
// The rule, stated once: a viewer is allowed in when the Plex account behind
// their token can reach THIS server — the one named by PLEX_MACHINE_ID. That
// is exactly the set of people the owner has shared a library with, so access
// follows Plex sharing and is revoked by unsharing. There is no allowlist to
// maintain and no second source of truth to drift.
//
//   npm run test:gate

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantsAccessTo, isOwnerOf, type PlexResource } from '../server/plex-gate.ts';

const MACHINE = 'abc123machine';

/** A resource row shaped like plex.tv/api/v2/resources returns them. */
function resource(over: Partial<PlexResource> = {}): PlexResource {
  return {
    clientIdentifier: MACHINE,
    provides: 'server',
    owned: false,
    home: false,
    ...over,
  };
}

// ─── Allowing in ─────────────────────────────────────────────────────────────

test('a token that can reach this server is allowed in', () => {
  assert.equal(grantsAccessTo([resource()], MACHINE), true);
});

test('the owner is allowed in', () => {
  assert.equal(grantsAccessTo([resource({ owned: true })], MACHINE), true);
});

test('this server among several is still a match', () => {
  const resources = [
    resource({ clientIdentifier: 'someone-elses-server' }),
    resource({ clientIdentifier: 'another-one' }),
    resource(),
  ];
  assert.equal(grantsAccessTo(resources, MACHINE), true);
});

// ─── Keeping people out ──────────────────────────────────────────────────────

test('a valid Plex account with no access to THIS server is refused', () => {
  // The case that matters most: Plex authentication succeeding proves only
  // that someone has a Plex account, which anyone can create in a minute. It
  // says nothing about whether the owner shared anything with them. Treating a
  // successful login as authorisation is the whole vulnerability.
  const strangersServers = [
    resource({ clientIdentifier: 'their-own-server', owned: true }),
  ];
  assert.equal(grantsAccessTo(strangersServers, MACHINE), false);
});

test('an account with no servers at all is refused', () => {
  assert.equal(grantsAccessTo([], MACHINE), false);
});

test('a non-server resource sharing the identifier does not grant access', () => {
  // plex.tv returns players and controllers from the same endpoint. Only
  // something that `provides` a server can be the library we are gating.
  const player = resource({ provides: 'player' });
  assert.equal(grantsAccessTo([player], MACHINE), false);
});

test('a resource that provides several roles still counts if one is server', () => {
  // Real rows carry comma-joined roles, e.g. "server,player".
  assert.equal(grantsAccessTo([resource({ provides: 'server,player' })], MACHINE), true);
});

// ─── Refusing to fail open ───────────────────────────────────────────────────

test('an unconfigured machine id refuses everyone rather than admitting everyone', () => {
  // A missing PLEX_MACHINE_ID is a deployment mistake. The dangerous reading is
  // "no server configured, so match anything"; this asserts the safe one.
  assert.equal(grantsAccessTo([resource()], ''), false);
  assert.equal(grantsAccessTo([resource()], undefined as unknown as string), false);
});

test('malformed rows are skipped, not trusted', () => {
  const junk = [
    null,
    undefined,
    {},
    { clientIdentifier: MACHINE },            // no provides
    { provides: 'server' },                    // no identifier
  ] as unknown as PlexResource[];
  assert.equal(grantsAccessTo(junk, MACHINE), false);
});

test('identifier matching is exact, not a prefix or substring', () => {
  // A near-miss identifier must not open the door.
  for (const id of [MACHINE + 'x', 'x' + MACHINE, MACHINE.slice(0, -1), MACHINE.toUpperCase()]) {
    assert.equal(
      grantsAccessTo([resource({ clientIdentifier: id })], MACHINE),
      false,
      `${id} must not match ${MACHINE}`,
    );
  }
});

// ─── Owner ───────────────────────────────────────────────────────────────────

test('owner is whoever Plex says owns this server', () => {
  // Deriving this from Plex rather than a configured account id means there is
  // no second place for it to be wrong, and no way to accidentally promote a
  // guest by mistyping a number in an env file.
  assert.equal(isOwnerOf([resource({ owned: true })], MACHINE), true);
  assert.equal(isOwnerOf([resource({ owned: false })], MACHINE), false);
});

test('owning a DIFFERENT server does not make you owner here', () => {
  const resources = [
    resource({ clientIdentifier: 'their-own-server', owned: true }),
    resource({ owned: false }),
  ];
  assert.equal(isOwnerOf(resources, MACHINE), false);
  assert.equal(grantsAccessTo(resources, MACHINE), true, 'still a guest here');
});

test('an unconfigured machine id has no owner', () => {
  assert.equal(isOwnerOf([resource({ owned: true })], ''), false);
});
