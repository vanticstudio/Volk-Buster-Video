// What the management console is allowed to write into every viewer's browser.
//
// This is a write primitive aimed at everybody. The owner picks a value on
// 3366, it is broadcast into every document load, and the bootstrap overwrites
// localStorage with it. The allowlist is the only thing that keeps that bounded,
// so these tests are less about features than about the blast radius.
//
// The drift half exists because the catalog is a HAND-CURATED mirror of a
// registry it cannot import (src/settings.ts will not load in Node — see the
// header of server/store-settings.ts). A mirror nothing checks is a mirror that
// silently stops matching, so these scan the registry as text — the same
// technique tools/list-slots.mjs already uses on video-case.ts, and for the
// same reason.
//
//   npm run test:storesettings

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONSOLE_SETTINGS,
  EXCLUDED_KEYS,
  RESERVED_KEYS,
  consoleSetting,
  validateSettings,
} from '../server/store-settings.ts';
import { policyKeys, loadPolicy, savePolicy, DEFAULT_POLICY } from '../server/admin-config.ts';
import { FrontDoorStore } from '../server/store.ts';
import { deriveKey } from '../server/secrets.ts';

const KEY = deriveKey('store-settings-test-key-long-enough');
const NOW = 1_757_000_000_000;
const fresh = () => new FrontDoorStore(':memory:', KEY);

const SETTINGS_SRC = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8');
const THEMES_SRC = readFileSync(new URL('../src/themes.ts', import.meta.url), 'utf8');

// ─── The allowlist ──────────────────────────────────────────────────────────

test('a key the console does not manage is refused, not silently dropped', () => {
  // The whole boundary. Without this the console degrades into "write any
  // localStorage key into every viewer's browser", which is a much larger
  // thing than a settings page.
  const { settings, errors } = validateSettings({ bb_not_a_real_setting: 'x' });
  assert.deepEqual(settings, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a setting this console manages/);
});

test('a reserved front-door key is refused even if it were catalogued', () => {
  // These carry the viewer's Plex connection and the flag that strips the
  // store to a viewer's menu. A settings map able to name them could hand
  // every viewer a different server, or switch viewer mode off for everybody.
  for (const key of RESERVED_KEYS) {
    const { settings, errors } = validateSettings({ [key]: 'https://evil.example' });
    assert.deepEqual(settings, {}, `${key} was accepted`);
    assert.match(errors[0], /reserved by the front door/);
  }
});

test('a dropdown value outside its own options is refused', () => {
  // Not belt-and-braces: a typo'd theme id goes out to EVERY viewer and the
  // store falls through to whatever its ?? supplies, which looks like the
  // console silently doing nothing.
  const { settings, errors } = validateSettings({ bb_theme: 'bb-1980' });
  assert.deepEqual(settings, {});
  assert.match(errors[0], /not one of its options/);
});

test('a valid dropdown value is kept', () => {
  const { settings, errors } = validateSettings({ bb_theme: 'bb-2010' });
  assert.deepEqual(settings, { bb_theme: 'bb-2010' });
  assert.deepEqual(errors, []);
});

test('checkboxes normalise to the 1/0 the store reads', () => {
  // The store reads these as string '1'/'0' from localStorage, never booleans.
  assert.equal(validateSettings({ bb_games_enabled: true }).settings.bb_games_enabled, '1');
  assert.equal(validateSettings({ bb_games_enabled: false }).settings.bb_games_enabled, '0');
  assert.equal(validateSettings({ bb_games_enabled: '1' }).settings.bb_games_enabled, '1');
  assert.equal(validateSettings({ bb_games_enabled: 'nonsense' }).settings.bb_games_enabled, '0');
});

test('free text is length-capped', () => {
  // It rides into an inline <script> on every document load. plex-connection.ts
  // handles the SHAPE (escaping); this handles the size.
  const { errors } = validateSettings({ bb_studio_picks: 'x'.repeat(501) });
  assert.match(errors[0], /too long/);
});

test('one bad entry does not discard the good ones', () => {
  // An owner changing five things and typoing one should not lose the other
  // four — but must still be told.
  const { settings, errors } = validateSettings({ bb_theme: 'bb-1993', bb_bogus: 'x' });
  assert.equal(settings.bb_theme, 'bb-1993');
  assert.equal(errors.length, 1);
});

test('a non-object body is refused rather than throwing', () => {
  assert.deepEqual(validateSettings(null).settings, {});
  assert.deepEqual(validateSettings('a string').settings, {});
  assert.deepEqual(validateSettings([1, 2]).settings, {});
});

// ─── What actually reaches the viewer ───────────────────────────────────────

test('an untouched setting emits no key at all', () => {
  // Absence has to mean "no opinion". Emitting a value for every catalogued
  // setting would pin thirty things the owner never chose, and would fight the
  // store's own defaults forever after.
  const keys = policyKeys({ ...DEFAULT_POLICY, settings: { bb_theme: 'bb-1993' } });
  assert.equal(keys.bb_theme, 'bb-1993');
  assert.equal(keys.bb_arrangement, undefined);
  assert.equal(keys.bb_outside, undefined);
});

test('a setting cannot displace the front door\'s own keys', () => {
  // policyKeys spreads settings FIRST so the dedicated fields win. This is the
  // guard that holds even when a policy object is built by hand rather than
  // coming through validateSettings.
  const keys = policyKeys({
    hiddenLibraries: ['m:1'],
    gamesEnabled: true,
    settings: { bb_games_enabled: '0', 'bb_carrylib_m:1': '1' } as Record<string, string>,
  });
  assert.equal(keys.bb_games_enabled, '1', 'the dedicated field must win');
  assert.equal(keys['bb_carrylib_m:1'], '0', 'the hidden library must stay hidden');
});

test('settings round-trip through the database', () => {
  const db = fresh();
  savePolicy(db, { hiddenLibraries: [], gamesEnabled: false, settings: { bb_theme: 'bb-2000' } }, NOW);
  assert.equal(loadPolicy(db).settings.bb_theme, 'bb-2000');
  db.close();
});

test('a corrupt settings row loads as empty rather than taking the store down', () => {
  // Read on every document load. Same tolerance hiddenLibraries already has.
  const db = fresh();
  db.setPolicy('settings', 'not json at all', NOW);
  assert.deepEqual(loadPolicy(db).settings, {});
  db.close();
});

test('a reserved key already in the database is stripped on the way OUT', () => {
  // A row written by an older build, or edited on disk, must not be able to
  // name a front-door key. Validation on the way in is not the only guard.
  const db = fresh();
  db.setPolicy('settings', JSON.stringify({ jellyfin_url: 'https://evil.example', bb_theme: 'bb-1990' }), NOW);
  const policy = loadPolicy(db);
  assert.equal(policy.settings.jellyfin_url, undefined);
  assert.equal(policy.settings.bb_theme, 'bb-1990');
  db.close();
});

// ─── Drift against the registry it mirrors ──────────────────────────────────

test('every catalogued key is still registered in the app', () => {
  // Catches a rename or a removal leaving a console control that writes a key
  // nothing reads — which fails silently in the worst way: the console saves
  // happily and the store ignores it.
  for (const def of CONSOLE_SETTINGS) {
    if (def.key.startsWith('bb_platform_')) continue; // template family, below
    const registered = SETTINGS_SRC.includes(`key: '${def.key}'`)
      || SETTINGS_SRC.includes(`'${def.key}'`);
    assert.ok(registered, `${def.key} is on the console but not in src/settings.ts`);
  }
});

test('every platform toggle the app registers is on the console', () => {
  // The family is generated by a loop, so a console list written by hand goes
  // stale the moment a platform is added.
  const registered = [...SETTINGS_SRC.matchAll(/registerPlatformSetting\('(\w+)'/g)].map((m) => `bb_platform_${m[1]}`);
  assert.ok(registered.length > 15, `only found ${registered.length} platforms — did the loop change shape?`);
  for (const key of registered) {
    assert.ok(consoleSetting(key), `${key} is registered but missing from the console`);
  }
});

/**
 * Every key src/settings.ts registers, however it spells it.
 *
 * THREE SPELLINGS, and the first version of this scan only knew one — it read
 * `key: '<literal>'` and quietly missed all ten cred() registrations (every
 * credential and hostname in the app) plus the one key written as a constant.
 * The test passed, and proving it could FAIL is what exposed that: removing an
 * exclusion changed nothing. A drift test that cannot fail is worse than none,
 * because it is also a claim that someone checked.
 */
function registeredKeys(): Set<string> {
  const keys = new Set<string>();
  for (const m of SETTINGS_SRC.matchAll(/^\s*key:\s*'([a-z_]+)'/gm)) keys.add(m[1]);
  // The credential helper — jellyfin_*, jellyseerr_*, tmdb_*, romm_*.
  for (const m of SETTINGS_SRC.matchAll(/\bcred\('([a-z_]+)'/g)) keys.add(m[1]);
  // `key: SOME_CONSTANT` — resolve it to the literal it was declared with,
  // which may be in ANOTHER module (FPS_METER_KEY lives in fps-meter.ts and is
  // imported). Resolving only within settings.ts silently dropped it, and the
  // classification test below went vacuous for that key.
  for (const m of SETTINGS_SRC.matchAll(/^\s*key:\s*([A-Z_][A-Z0-9_]*),/gm)) {
    const decl = new RegExp(`${m[1]}\\s*=\\s*'([a-z_]+)'`);
    let hit = SETTINGS_SRC.match(decl);
    if (!hit) {
      const from = SETTINGS_SRC.match(new RegExp(`import\\s*\\{[^}]*\\b${m[1]}\\b[^}]*\\}\\s*from\\s*'\\.\\/([\\w-]+)'`));
      if (from) {
        try {
          hit = readFileSync(new URL(`../src/${from[1]}.ts`, import.meta.url), 'utf8').match(decl);
        } catch { /* module moved — the assertion below reports the shortfall */ }
      }
    }
    if (hit) keys.add(hit[1]);
  }
  return keys;
}

test('the registry scan sees every spelling, not just the easy one', () => {
  // Guards the guard. If this count collapses, the classification test below
  // starts passing vacuously — which is exactly how it shipped broken once.
  const keys = registeredKeys();
  assert.ok(keys.size >= 45, `only scanned ${keys.size} keys — has the registry changed shape?`);
  assert.ok(keys.has('bb_theme'), 'missed a plain literal key');
  assert.ok(keys.has('romm_apikey'), 'missed a cred() registration');
  assert.ok(keys.has('bb_fps_meter'), 'missed a constant-spelled key');
});

test('every registered setting is classified — offered or excluded, never forgotten', () => {
  // THE DRIFT THAT ACTUALLY HAPPENS: someone adds a setting to src/settings.ts
  // and never thinks about the console. This makes that a build failure with a
  // name attached, rather than a control quietly missing for a year.
  const unclassified = [...registeredKeys()]
    .filter((k) => !consoleSetting(k) && !(k in EXCLUDED_KEYS));
  assert.deepEqual(unclassified, [],
    'these are registered but neither offered nor excluded — decide, and write the reason down');
});

test('nothing is both offered and excluded', () => {
  const both = CONSOLE_SETTINGS.filter((d) => d.key in EXCLUDED_KEYS).map((d) => d.key);
  assert.deepEqual(both, []);
});

test('every exclusion carries a reason', () => {
  // The point of an explicit skip-set is that the argument is written where the
  // next person changing it will read it — the same rule store-config-keys.ts
  // states for its own.
  for (const [key, reason] of Object.entries(EXCLUDED_KEYS)) {
    assert.ok(reason.length > 20, `${key}'s exclusion reason is too thin to act on`);
  }
});

test('the theme dropdown lists exactly the eras the store has', () => {
  // Catches a new era shipping in the store and never appearing on the console.
  const eras = [...THEMES_SRC.matchAll(/^\s{4}id:\s*'(bb-[^']+)'/gm)].map((m) => m[1]);
  assert.ok(eras.length >= 4, `only found ${eras.length} eras`);
  const offered = consoleSetting('bb_theme')?.options?.map((o) => o.id) ?? [];
  assert.deepEqual([...offered].sort(), [...eras].sort());
});

test('no catalogued dropdown is missing its options', () => {
  // A dropdown with no options renders as "Store default" and nothing else —
  // a control that looks present and can set nothing.
  for (const def of CONSOLE_SETTINGS) {
    if (def.control !== 'dropdown') continue;
    assert.ok(def.options && def.options.length > 0, `${def.key} is a dropdown with no options`);
  }
});

test('every default is a value the control can actually produce', () => {
  // A "Store default" the dropdown cannot offer means reverting is impossible
  // through the UI — the exact state that strands viewers on an old value.
  for (const def of CONSOLE_SETTINGS) {
    if (def.control === 'dropdown') {
      assert.ok(def.options!.some((o) => o.id === def.default),
        `${def.key} defaults to "${def.default}", which is not one of its options`);
    }
    if (def.control === 'checkbox') {
      assert.ok(def.default === '1' || def.default === '0', `${def.key} default is not 1/0`);
    }
  }
});

test('no secret or hostname is on the console, by shape as well as by name', () => {
  // A second net under the curation: anything that reads like a credential or
  // an address must not have slipped into the catalog.
  for (const def of CONSOLE_SETTINGS) {
    assert.doesNotMatch(def.key, /apikey|password|token|secret/i, `${def.key} looks like a credential`);
    assert.doesNotMatch(def.key, /_url$/, `${def.key} looks like an address`);
  }
});
