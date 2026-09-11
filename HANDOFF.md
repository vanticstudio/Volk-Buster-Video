# VolkBuster — In-Flight Work Handoff

> **Read this first if you're picking up the session.** It captures what's done,
> what's queued, the exact integration points, and the traps already hit.

## Status: QUEUE COMPLETE (this session built items 1–7 below)

Everything in the "queue" section of the original handoff is now DONE and
verified: 676/676 tests, both typechecks, all three custom gates, file budget,
and the full `npm run build` (3.1s, clean).

### What this session added (on top of the table below)

| Change | Files | What it does |
|---|---|---|
| GPU verdict in UI | `src/three-scene.ts` (`GpuVerdict` export + `__gpuVerdict`), `src/main.ts`, `src/boot-loader.ts` | Boot loader tells a viewer "this device is drawing the store without a graphics card" when software-GL is detected. |
| Boot loader extraction | `src/boot-loader.ts` (new) | Friendly-loader helpers extracted from main.ts for its line budget. |
| Perf diagnostic row | `src/perf-diagnostic.ts` (new), `src/settings.ts` (`bb_perf_check`), `server/store-settings.ts` (excluded w/ reason) | Hidden SERVICE MODE row whose live hint IS the verdict: GPU, tier, fps p50/p90/worst hitch + attributed spans, draw calls, res %. |
| caseMaterialLRU graveyard | `src/video-case.ts` | Eviction disposal deferred 30 s so the re-upload lands at idle, never inside the transition that triggered it. Teardown drains the graveyard. |
| Door chime variants | `src/door-chime.ts`, `src/settings.ts`, `server/store-settings.ts` | `bb_door_chime`: Classic recording / Electronic / Brass / Glass (synthesized — no assets). Console dropdown row added. |
| Closed-for-the-night saver | `index.html`, `src/styles.css`, `src/screensaver.ts`, `src/main.ts`, settings + console | `bb_closed_mode`: saver shows a SORRY—WE'RE CLOSED card instead of the bouncing tape; the parked frame dresses down to night rig + marquee chase, restored on wake. |
| displayHz re-measure | `src/display-hz.ts`, `src/main.ts` | `remeasureDisplayHz()` fires once when textures finish — upgrade-only, so kiosk load can't undo boot's verdict. |
| viewer_only trust note | `src/store-config-keys.ts` | The decision (flag is acceptable; boundary is Plex; server claim if the threat model changes) written where the flag lives. |

## Current state of the working tree (uncommitted, all verified green)

These are **done and verified** (676/676 tests, `tsc`, `tsc -p server`, all three
custom gates, file budget, full build). Nothing is committed yet — review with
`git diff`.

| Change | Files | What it does |
|---|---|---|
| Duplicate-skip retarget defer | `src/store-nav.ts`, `src/store-camera.ts`, `src/three-scene.ts` | One `updateCameraTarget()` per duplicate-skip walk instead of N (was O(slots) × N per keypress). |
| Resize-grace preservation | `src/three-scene.ts` | `Math.max(resScaleWindowStart, time)` on both early returns in `updateDynamicResolution` — the grace can no longer be erased. |
| Hero-face upload queueing | `src/video-case.ts` | The four 960×1440 hero faces now upload through the budgeted priority queue instead of synchronously inside the first inspect frame. |
| Bloom divisor on tier change | `src/three-scene.ts` | `applyRenderResolution()` fires on ACTIVE↔VIDEO tier transitions so VIDEO-tier bloom actually drops to half res. |
| Calibration TTL | `src/quality-calibrate.ts` | 30-day TTL on the cached GPU calibration (`bb_quality_stamp`). |
| Per-mirror reflector sizes | `src/store-mirrors.ts`, `src/store-shell.ts` | `reflectorTargetSize(renderer, scale)`; the grazing soffit band renders at 0.5×. |
| Door-chime debounce + extraction | `src/door-chime.ts` (new), `src/three-scene.ts` | 4 s debounce collapses the 4–5 door triggers into one ring per pass; chime extracted to its own module (three-scene was over budget). |
| Friendly boot loader | `index.html`, `src/styles.css`, `src/main.ts` | Public :3355 gets a status line + progress bar + rotating flavor; owner keeps the raw ops log. Re-arms on rebuild. |
| Faster first paint | `src/main.ts` | Reveal at 90% settled or 20 s, whichever first (was `Promise.all` of every poster). |
| **GitHub update manager** | `server/version.ts` (new), `server/update-manager.ts` (new), `server/admin.ts`, `server/admin-page.ts`, `server/index.ts` | Owner-only update check + one-click apply on :3366. Version now read from `package.json` (was hardcoded `'0.15.0'` ×2). |

## The queue (what's left)

Ordered by value. Each is independent; verify after each with the standard
gates (`npx tsc --noEmit`, `npx tsc -p server --noEmit`, `npm test`,
`node tools/check-file-budget.mjs`, `node tools/check-provider-boundary.mjs`,
`node tools/list-slots.mjs --check`).

### 1. GPU verdict in the UI — top pick
The code **detects** software rasterization / WebView2-picks-iGPU / WebKitGTK
synchronous GL and only `console.log`s it. Surface it on the boot loader and/or
the counter terminal.
- Detection: `src/three-scene.ts:1853–1876` (`softwareGL`, `integratedGL`, `gpuName`).
- Boot loader status hook: `src/main.ts` `setBootStatus()` / `friendlyBootStatus()`.
- Counter terminal rows: `src/counter-terminal.ts` (`COUNTER_TERMINAL_LABELS`, `VIEWER_TERMINAL_ROWS`).
- Small, high leverage — kills the #1 support question ("4–5 FPS on a very good PC").

### 2. Perf diagnostic screen (SERVICE MODE row)
A 10-second scripted sweep (walk 3 sections, inspect 1 case, 1 checkout flourish)
rendering a one-screen verdict: median frame time, worst hitch + attributed span,
GPU adapter, tier, texture queue depth.
- Data: `window.__perfTrace.report()` (`src/perf-trace.ts`), `scene.getPerfInfo()` (`src/three-scene.ts:4327`).
- SERVICE MODE page: `src/settings.ts` (`hidden: true` registrations), `src/main.ts:1282` (`settingsPage === 'Service'`).
- The sweep can drive `storeScene.moveLeft()/moveRight()` + `inspect` programmatically.

### 3. `caseMaterialLRU` dispose-while-referenced fix
Eviction disposes textures still bound to carried/endcap/back-room meshes →
unbudgeted re-upload inside `render()`. Fix: reference-check before dispose.
- LRU: `src/video-case.ts:953–973` (`caseMaterialLRU`, `CASE_MATERIAL_LRU_CAP = 64`).
- **Caller map (already traced):** the non-hero getters (`getRentalFrontMaterial`,
  `getRentalBackMaterial`, `getJellyfinBackMaterial`, `getRentalSpineMaterial`,
  `getPosterMaterial`) are called **only inside `video-case.ts`** — by the
  `createHero*` factories and per-slot `loadShelfDetails` closures. The
  `createHero*` factories are called from `store-inspect.ts`, `store-checkout.ts`,
  `back-room.ts`. Long-lived meshes: hero front/back, carried stack, back-room
  tapes, person-endcap cases.
- The comment at `video-case.ts:945–952` already documents the "deliberately
  tolerated" eviction — the fix is a referenced-check, not a redesign.

### 4. Owner-selectable door chime
`public/sounds/door_bell.mp3` is already a file. Add a console setting to pick
the chime (1990 electronic two-tone / 1993 brass bell / 2000 glass-door) or
drop a custom one in `user-assets/`.
- Chime: `src/door-chime.ts` (extracted this session).
- Console settings catalog: `server/store-settings.ts` (`CONSOLE_SETTINGS`).
- Asset drop-in pattern: `src/user-assets.ts`.

### 5. "Closed for the night" screensaver mode
Compose existing systems: night lighting rig + marquee slow-chase + ceiling TVs
showing a closed card + clerk goes home. Zero new systems.
- Screensaver: `src/screensaver.ts`. Day/night rig: `src/outdoor-lighting.ts`.
- Marquee: `src/three-scene.ts` `buildMarqueeBulbs` / `setMarqueeAnimMode`.
- Clerk sleep: `src/three-scene.ts` `CLERK_SLEEP_INPUT_MS`.

### 6. Re-measure displayHz after textures ready
`measureDisplayHz()` samples ~45 rAF ticks during the boot decode storm; a loaded
kiosk can land on the 60 Hz default for a 120 Hz panel and never re-measure.
Re-run once after `texturesReadyPromise` resolves.
- `src/display-hz.ts:89–114`. Boot resolution: `src/main.ts` `scene.texturesReadyPromise.then(...)`.

### 7. `bb_viewer_only` trust-model note
`bb_viewer_only` is a localStorage flag — a viewer with devtools can flip it and
get the settings drawer. Fine for LAN-trusted Plex users; if it's a real threat,
it needs to be a server-side session claim, not a client flag. **Decide which,
then either document or fix.**
- `src/store-config-keys.ts:45` (`isViewerOnly()`).

## Traps already hit (don't rediscover)

- **File budget:** `src/three-scene.ts` has a 6200-line hard ceiling
  (`tools/check-file-budget.mjs`). Any addition there must extract — the
  door-chime extraction this session is the pattern. Current: ~6150.
- **The grep loop:** twice I re-ran the same "find external callers" grep ~30×
  after the answer was already empty. The answer was correct the first time —
  the non-hero getters have **no external callers** outside `video-case.ts`.
  Don't re-trace it.
- **Update manager:** the routes are already correct in `server/admin.ts:199–217`.
  A mid-edit "malformed comment" was a false alarm in my own old-string, not the
  file. Don't "fix" it again.
- **Version:** now from `package.json` via `server/version.ts`. The two old
  hardcoded `'0.15.0'` strings in `server/index.ts` are gone — don't re-add.

## How to verify (run all, in this order)

```bash
npx tsc --noEmit
npx tsc -p server --noEmit
npm test                                    # 676 tests
node tools/check-file-budget.mjs
node tools/check-provider-boundary.mjs
node tools/list-slots.mjs --check
```

Full build (all gates + both typechecks + vite): `npm run build`.
