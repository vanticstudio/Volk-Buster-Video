# VolkBuster — In-Flight Work Handoff

> **Read this first if you're picking up the session.** It captures what's done,
> what's queued, the exact integration points, and the traps already hit.

## Status: front-to-back audit run; items 1–4 + 6 SHIPPED AND VERIFIED; items 5 + 7 STAGED

A full audit (6 parallel agents) produced a ranked findings list; the top items
were built this round. All verified: **684/684 tests**, both tsc, all three
gates, provider boundary (updated ALLOWED), full `npm run build` 3.1s clean.

### What this round added

| Change | Files | What it does |
|---|---|---|
| plex.tv outage ≠ revocation | `server/plex-client.ts`, `server/index.ts`, `server/admin.ts`, `server/plex-connection.ts`, `tests/front-door-http.test.ts` (+3 tests) | `fetchResources` returns `null` when unanswered (vs `[]` = genuinely nothing). Re-validation keeps sessions on outage; sign-in fails closed with an honest 502. All plex.tv calls get 10s timeouts. |
| Plex transcode teardown | `src/playback-routing.ts`, `src/video-player.ts` | Mint-time session record (`getLastTranscodeSession`/`stopLastTranscode`); the player tears down Plex encodes with Plex's stop endpoint — was Jellyfin-shaped 404s, leaking ffmpeg jobs per track change. |
| Plex audio switching | `src/plex.ts` (`audioStreamID`), `MediaStreamInfo.id`, `TrackChoice.id`, `StreamSelection`/`StreamUrlOptions` ids, player menu rows | Plex transcoder is addressed by stream ID not index — the picker's audio switch was a silent no-op. |
| Episode scrobble + mpv→Plex reports | `src/main.ts`, `src/playback-flow.ts` (`PlaybackReport` sink) | Episode runtime rides `playbackStopped` (was `movie.runTimeTicks`, undefined for series → episodes never marked watched); mpv reports go through kind-aware routing (was Jellyfin POSTs at Plex). |
| Plex subtitles | `src/main.ts` via `coercePlexSubtitleDelivery` (jellyfin.ts) | Plex burns ALL subtitles (text coerced to burn-in — no verified VTT endpoint; the exact upgrade spot is marked in jellyfin.ts). Burn-in params in `plexTranscodeParams`. |
| Release workflow | `.github/workflows/release.yml` (new) | On `v*.*.*` tag: tests+gates, tag==package.json guard, publishes the GitHub Release. **The update manager had nothing to check — zero releases existed.** Cut: bump package.json, `git tag v… && git push origin v…`. |
| CI on PR | `.github/workflows/ci.yml` (new) | PRs run tests + both typechecks + all gates + build. |
| Version reconciliation | `package.json`→2.0.1, Tauri conf/Cargo, Android versionName/Code, APK artifact → `volkbuster-tv-apk`, APK workflow trigger `master,dev`→`main` | Client version now from package.json via Vite `define` (`__APP_VERSION__`); the literal in `setup-failure-report.ts` drifted once already. |
| Update-manager hardening | `server/update-manager.ts` | Errored checks no longer cached an hour; hung `update.sh` killed at 20 min so the single-flight job can't wedge forever. |
| Glide frame-rate compensation | `src/three-scene.ts` | Glide lerp solved per frame via `framesElapsed` (same shape as popLerp) — slow frames no longer stretch the settle to ~20 multi-second composites. |
| Walk-key wake guards | `src/three-scene.ts` | `handleWalkKeyDown/Up` guard before waking — typing in search/settings no longer costs 3 composites per keystroke; keyup still clears held keys (no stuck-walk), wakes only for real walk keys. |
| Store hours + clock env | `src/store-hours.ts` (new), `src/settings.ts` + console rows, `tests/store-hours.test.ts` (5 tests) | `bb_store_hours` ("9:00-21:00", midnight-crossing OK) + `bb_clock_env`: closed→night, open→day/sunset/night by hour; 5-min scheduler; screensaver restore respects the clock. |

### Staged for a FRESH session (deliberately not started here)

- **On-screen keyboard** (audit G1): setup text fields, search, clerk chat are
  unreachable on TV remote/touch. One CRT-styled QWERTY component covers all;
  the desk CRT (`setTerminalText`) is the surface. Big but self-contained.
- **Spine text + boxart fallback** (the two biggest visual wins): spine strips
  are a new texture-array channel in `video-case.ts` — which sits at **5988/6000
  budget lines**; extract first. Boxart fallback: `PosterLoadingQueue.load`
  bails when `!posterUrl` (`video-case.ts:1785`) → artless Plex titles render
  as flat `#0f172a`; a procedural typed-cover (title/genre/year, like
  `game-carton-art.ts`) feeds the existing decode/stamp path.

### Earlier audit-fix waves (all shipped, committed)

The "queue complete" table below covers the FIRST feature wave (update manager,
boot loader, chime variants, closed-mode saver, perf diagnostic, etc. — all
committed). The full audit findings list (server security, playback gaps,
visual wins, flow gaps, housekeeping — each with file:line) is in the session
record; top unfixed items beyond the staged two: remote-play middleware
reachable by viewers (audit #7), admin CSRF Origin check, IndexedDB poster
cache caps, Plex catalog sync pagination, Continue Watching surface,
prefers-reduced-motion, trunk of letterboxd integration.

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
