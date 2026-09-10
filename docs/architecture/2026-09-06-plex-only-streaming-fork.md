# Design: Plex-only, GPU-streamed, multi-user store

**Date:** 2026-09-06
**Status:** Phases 0 and 1 implemented; Phase 2 (instances) next

**Progress**
| Phase | State |
|---|---|
| 0 — Subtract | **Done.** 2.5D mode and the device gate removed; Plex is the only registered provider. `main.ts` went from 3 lines of budget headroom to 176. |
| 1 — Front door | **Done.** `server/` — Plex PIN sign-in, the shared-access gate, signed sessions, encrypted token storage, per-user config with server-side owner enforcement. 71 new tests. |
| 2 — Instances | Next. Attaches at `requireSession` in `server/index.ts`. |
| 3–6 | Not started. |

Verified on 2026-09-06: 530/530 tests pass across five consecutive runs; three
consecutive full builds pass all three gates plus both typechecks; the front
door boots, refuses every unauthenticated route, and was checked against live
plex.tv (pin creation succeeds, an unauthorised pin returns null, and an invalid
token yields no resources — so the gate fails closed).

**Supersedes:** the single-user local-client model described in `README.md`

---

## 1. Context

Upstream Halcyon Video is a single-user client. It runs in one person's browser
on one machine, holds credentials in `localStorage`, renders the 3D store
locally, and treats the local network as trusted. Every one of those assumptions
is load-bearing in the current code, and every one of them is wrong for what we
are building.

This fork turns it into a small multi-user service running on the same machine
as the Plex library, reachable worldwide through a Cloudflare Tunnel, gated to
people who already have access to that Plex server.

### Why the changes are one change

Four requests drove this design, and they converge:

1. **Drop 2.5D flat mode** — 3D only.
2. **Render on the host GPU, stream to clients** — so the store is smooth and
   does not rebuild on every visit.
3. **Plex only, gated by Plex account access** — the Overseerr model.
4. **Usable on mobile** — currently renders 16:9 on phones, which is unusable.

They are not independent. Removing Jellyfin removes the cross-device settings
store, because config sync currently lives in *Jellyfin's* DisplayPreferences
(`src/jellyfin.ts:1608`, `DISPLAY_PREFS_CLIENT`) and Plex has no equivalent. The
Plex gate needs a server to verify sharing. GPU streaming needs a session
manager. That is one server, built once, not three.

Two things fall out for free:

- Deleting flat mode returns headroom to `src/main.ts`, which sat at 4,597 lines
  against a hard 4,600-line build gate. After Phase 0 it is 4,424 — from three
  lines of room to 176.
- The device gate's only job today is offering 2.5D to weak devices. In a
  stream-only build the weak-device path *becomes* the streaming path, so the
  gate's purpose is absorbed rather than replaced.

  Stated precisely, because it is easy to get backwards: **the viewer's browser
  no longer needs WebGL2 at all.** It receives a video stream and sends input.
  Only the headless instance renders. `src/device-gate.ts` is therefore deleted
  outright rather than reduced to a capability check — the capability it tested
  for is now the server's problem, not the client's. A phone that could never
  have run the 3D store runs this fine.

---

## 2. Goals

- One rendering path: 3D, rendered server-side on the host GPU.
- A viewer's store stays standing between visits within an idle window, so
  returning does not pay the scene-build cost.
- Access is granted by Plex library sharing and revoked the same way, with no
  allowlist to maintain.
- Each viewer sees their own libraries, writes their own watch state, and keeps
  their own store preferences.
- Administration is owner-only, enforced server-side.
- Works on a phone in portrait.
- Nothing but the front door is reachable from the internet.

## 3. Non-goals

Explicitly out of scope, to keep this shippable:

- Jellyfin, Emby, or any second backend.
- A local (non-streamed) render path as a supported front door.
- Shared/co-op browsing of one store by several people at once. The repo has
  `src/shared-place.ts`; we are not building on it here.
- Transcoding video on the host GPU. The GPU budget is for rendering the store.
  Plex's own transcoding is a separate, pre-existing consumer of that hardware.
- Migrating existing upstream installs. This fork breaks compatibility with the
  single-user model deliberately.

---

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Stream-only; delete flat mode | One path to build, secure and test. Weak devices get the stream. |
| D2 | Plex only; delete Jellyfin | Matches the deployment. Removes ~2,600 lines and one whole auth flow. |
| D3 | Keep the provider abstraction | It is the only build-enforced boundary in the codebase and costs nothing to keep. |
| D4 | Separate front-door service | Auth cannot live inside the process that exposes `/dev-proxy`, `/__play` and `/__feedback`. Unreachable beats gated. |
| D5 | Cloudflare TURN for media | Cloudflare Tunnel carries HTTP/WS/TCP but **not** WebRTC media. TURN keeps the zero-open-ports property. |
| D6 | Per-user Plex identity | Viewers see only what is shared with them; watch state is theirs. |
| D7 | Per-user store preferences, owner-only admin | "Their library, their store, your admin." |
| D8 | Sticky instances for an idle window | Directly answers "stop it building every time"; gives a predictable VRAM ceiling. |
| D9 | Playback hands off to the client | Avoids double-transcoding a movie through the stream encoder; preserves picture quality. |
| D10 | Per-session viewport | Mobile portrait is an instance-spawn parameter, not a responsive rewrite. |

---

## 5. Architecture

```
Internet ──▶ cloudflared ──▶ front door :8080            ← only public surface
                              ├─ Plex PIN OAuth
                              ├─ shared-access gate
                              ├─ sessions (signed cookie)
                              ├─ per-user config store (SQLite)
                              ├─ instance pool + lifecycle
                              ├─ playback URL minting
                              └─ admin routes (owner only)

              127.0.0.1 ─────┬─ vite preview :1420       ← never exposed
                             └─ headless instances       ← one per active user
                                 (Chromium, GPU, seeded
                                  per-session, sized to
                                  the client's aspect)

Cloudflare TURN ◀──── SRTP ────▶ viewer's browser
```

Everything except the front door binds to loopback. The existing dev/preview
middleware is not gated; it is made unreachable.

### 5.1 Component: front door

New service. Node, no framework requirement beyond an HTTP router. Owns:

- **Auth** — Plex PIN flow, shared-access verification, session issuance.
- **Sessions** — signed `httpOnly; Secure; SameSite=Lax` cookie carrying an
  opaque session id; server-side record holds Plex user id, encrypted Plex
  token, owner flag, and the instance assignment.
- **Config** — per-user `bb_*` key/value store.
- **Instances** — pool, assignment, sticky window, eviction, health.
- **Playback** — mints short-lived, session-scoped media URLs.
- **Admin** — owner-only routes; also the only writer of owner-only config keys.
- **Static** — serves the viewer client (the thin page that receives the stream).

It is the only process `cloudflared` points at.

### 5.2 Component: instance manager

Extends the ideas in `tools/remote-play-server.mjs`, but lifted out of the Vite
plugin and into the front door. Responsibilities:

- Maintain a pool of headless Chromium instances with GPU access.
- Spawn an instance with a **viewport matching the client's reported aspect
  ratio**, from an allowed set (see §5.7).
- Seed each instance with the assigned viewer's Plex token via a one-time
  ticket redeemed over loopback — **never a file on disk**.
- Hold a user's instance for a configurable idle window after disconnect
  (default 4 hours), then tear it down and reclaim VRAM.
- Enforce a hard concurrency cap (`INSTANCE_CAP`, default 6) and serve a
  "the store is full" screen past it rather than degrading.
- Reap crashed or unresponsive instances.

### 5.3 Auth and the Plex gate

Standard Plex PIN flow; `src/plex-signin.ts` already implements this dance
client-side and is the reference for the server-side port.

1. `POST https://plex.tv/api/v2/pins` (strong) → `{ id, code }`.
2. Viewer completes auth at `https://app.plex.tv/auth#?clientID=…&code=…`.
3. Poll `GET https://plex.tv/api/v2/pins/{id}` until an `authToken` appears.
4. With that token, `GET https://plex.tv/api/v2/resources?includeHttps=1`.
5. **Gate:** the configured `PLEX_MACHINE_ID` must appear among the servers that
   token can reach. If it does not, reject.
6. **Owner:** the token's Plex account id equals the configured `OWNER_PLEX_ID`.

Access therefore follows Plex sharing automatically. Sharing a library grants
entry; unsharing revokes it at next sign-in. There is no separate allowlist.

Session records are re-validated against step 4 periodically (default: every 24h
of session life) so that revoked sharing does not leave a live session standing
indefinitely.

### 5.4 Per-user configuration

This is smaller than it first appears. `src/store-config-sync.ts` and
`src/store-config-keys.ts` already implement the correct shape: a prefix rule
deciding which `bb_*` keys sync, a pull on boot, a debounced push on change, and
a `SKIP_KEYS` / `SKIP_PREFIXES` opt-out list. We repoint the backend from
Jellyfin DisplayPreferences to the front door. The skip-list logic survives
unchanged.

Two additions:

- **Owner-only key set.** A new set in `store-config-keys.ts` naming keys only
  the owner may write: brand and emblem, connection and setup, media roots,
  anything destructive. The front door **rejects non-owner writes to these keys
  server-side**. The UI also hides them, but the UI is not the enforcement.
- **Per-user keys.** Everything else — era, lighting, floor plan, media format,
  quality — is per-user, keyed by Plex account id.

Note that config sync in the current codebase is **opt-out**: any new `bb_`
key syncs unless skipped. That property is retained, and it now means "syncs to
this user's row", which is the desired behaviour.

> **Known gap carried forward:** roughly a dozen modules read `localStorage`
> directly rather than through the settings registry (`store-shell.ts`,
> `store-mirrors.ts`, several render flags in `three-scene.ts`). Those reads
> still work, because each instance has a real `localStorage` that we hydrate at
> spawn. Restoring config *before* the app boots is therefore a hard ordering
> requirement, not a nicety. See §5.8.

### 5.5 Instance lifecycle and VRAM

Per-user sticky instances with a fixed idle window.

```
sign in ──▶ assign instance ──▶ build (~9.5s, once)
                                   │
                          disconnect (tab closed)
                                   │
                        hold for IDLE_WINDOW (default 4h)
                            │                  │
                    reconnect within        window expires
                            │                  │
                    instant reattach        tear down,
                    (same aisle, same       reclaim VRAM
                     carried tape)          (next visit rebuilds)
```

Idling is cheap in compute: the app's three-tier ACTIVE/VIDEO/IDLE renderer and
screensaver mean an unattended store composites nothing. **The cost of
persistence is VRAM, not CPU or GPU time.**

VRAM is therefore the binding constraint on `INSTANCE_CAP`. The high-res poster
bank is a `DataArrayTexture` of 320×480 RGBA layers; a large working set plus
mip chain is plausibly over a gigabyte per instance, which does not multiply by
six on a consumer card.

**Mitigation, and the reason this design is affordable:** those textures are
sized for a local display that might be 4K. In a stream-only build the output is
a compressed 1080p WebRTC frame. Halving the high-res bank to 160×240 is
approximately a 4× VRAM reduction per instance and should be indistinguishable
on a streamed frame.

This must be **measured before the pool is built around it** (§9, R1).

### 5.6 Playback handoff

The store stream is the browsing experience. The movie is not composited into
it.

```
[streamed 3D]  browse → checkout → clerk bags it → VCR → TV glows
                                                          │
                                              control-channel message
                                                          ▼
[viewer's own browser]        native player, direct from Plex
                                                          │
                                              exit signalled back
                                                          ▼
[streamed 3D]  store resumes — tape returns, ritual continues
```

- The instance emits `{ action: 'play', ratingKey, offsetMs }` on the control
  channel instead of opening its own fullscreen player.
- The viewer requests a playback URL from the front door, which mints a
  **short-lived, session-scoped** URL. The raw Plex token never reaches the
  client.
- Direct play where the client supports it; Plex's own transcode where it does
  not. The host GPU never touches the video.
- During playback the instance drops to its existing **IDLE tier** and stops
  encoding, returning GPU headroom for the duration.
- On exit, the viewer signals back and the store resumes.

### 5.7 Mobile and portrait

The structural fix is per-session viewport: the instance is spawned at the
client's aspect ratio rather than a fixed 16:9. Supported viewports are drawn
from a small allowed set (landscape 16:9, portrait 9:16, plus a tablet ratio) so
that the pool stays predictable and a hostile client cannot request an arbitrary
resolution.

On top of that, two real pieces of work:

- **Camera framing** in `src/store-camera.ts`. A 9:16 aisle is a different shot,
  not a squeezed one — FOV and shelf framing need portrait variants.
- **Portrait DOM layouts** in `src/styles.css`. Every overlay in `index.html`
  was designed for a landscape 10-foot UI.

Touch transport already exists on both ends (`src/store-touch.ts`,
`src/remote-touch.ts`) and is reused as-is.

### 5.8 Boot ordering inside an instance

Ordering here is load-bearing and not type-checked. An instance must:

1. Receive its one-time ticket and redeem it over loopback for the viewer's Plex
   token and config blob.
2. Hydrate `localStorage` with that user's `bb_*` keys **before the app's module
   body runs**, because settings are read synchronously at import time in
   several places (notably `src/store-layout.ts`, which resolves the store
   format at module evaluation).
3. Then boot the app, which proceeds through its existing sequence: brand pack,
   then fonts, then scene. That order is already load-bearing upstream — sign
   canvases paint once into a texture cache, so a late brand or font bakes in
   permanently.

---

## 6. Data model

SQLite, owned by the front door.

```
users        plex_user_id PK, plex_username, is_owner,
             first_seen_at, last_seen_at

sessions     session_id PK, plex_user_id FK, token_encrypted,
             created_at, last_validated_at, expires_at,
             client_aspect

user_config  plex_user_id, key, value, updated_at
             PRIMARY KEY (plex_user_id, key)

instances    instance_id PK, plex_user_id FK, pid, viewport,
             state, spawned_at, last_attached_at, release_after
```

Plex tokens are encrypted at rest with a key from the environment, never logged,
and never returned to a client.

---

## 7. Security

The current codebase's threat model is an explicitly trusted LAN. Going public
invalidates it. Non-negotiable items:

| Item | Action |
|---|---|
| Front door | Only origin `cloudflared` points at |
| Vite preview, instances | Bind `127.0.0.1` |
| `/dev-proxy` (arbitrary fetch relay) | Deleted from the code, not env-flagged |
| `/__play` (spawns mpv) | Deleted from the code, not env-flagged |
| `/__feedback` (writes files, 20 MB) | Deleted from the code, not env-flagged |
| `/__remote/*` | Absorbed into the authenticated front door |

"Deleted, not env-flagged" is deliberate and applies to all three. A disabled-by-
default flag is one misconfiguration away from an arbitrary fetch relay and a
process spawner on a host that holds a media library. These middlewares exist to
serve local development; if a developer needs them later they can be restored
behind a loopback-only dev build, which is a separate, reviewable change.
| `.remote-play-seed.json` | Deleted; per-session ticket instead |
| Plex tokens | Encrypted at rest |
| PIN flow | Rate-limited |
| `network_mode: host` in compose | Dropped — Cloudflare TURN should make it unnecessary |
| Owner-only config keys | Enforced server-side, not just hidden |
| `setup-failure-report.ts` scrubber | Extended to cover every new auth path |

`vite.config.ts:251` hardcodes `MEDIA_ROOTS` to the upstream author's NAS layout
(`/mnt/data1`…`/mnt/data4`). This becomes configuration, or is removed with
`/__play`.

---

## 8. Testing

The pure-logic half of this codebase is well covered — 465 tests across 43 files
in about a second, using `node --experimental-strip-types --test` with no
framework. The rendering half has effectively none, and the screenshot harness
referenced throughout the source (`tools/shot.mjs`, `harness.ts`) is absent from
this checkout.

- **Front door is written test-first.** It is a security boundary. The gate
  check, session lifecycle, owner-key enforcement, eviction policy and ticket
  redemption are all pure logic and fit the existing idiom.
- **Phase 0 is guarded by the existing suite.** Deleting flat mode and Jellyfin
  must leave the remaining tests green; tests belonging to deleted subsystems
  are deleted with them.
- **A minimal screenshot harness is rebuilt in Phase 5**, before camera framing
  and aspect ratio change. That class of change has no regression net otherwise.
- **Instance lifecycle gets an integration test** against a stub browser process,
  so pool, eviction and cap logic are exercised without a GPU.

---

## 9. Risks and unknowns

| | Risk | Mitigation |
|---|---|---|
| R1 | VRAM per instance may not permit 6 resident stores | Measure one real instance before building the pool. Validate the 160×240 texture cut early. `INSTANCE_CAP` is configuration, not a constant. |
| R2 | GPU contention with Plex's own transcoding | Both draw on the same card. Budget the cap against peak Plex load, not an idle card. |
| R3 | Cloudflare TURN cost is metered per GB | Measure a real session's bitrate before opening access widely. |
| R4 | Portrait framing may need art/layout decisions, not just code | Rebuild the screenshot harness first (Phase 5) so the change is reviewable. |
| R5 | Deleting Jellyfin touches the provider boundary guard | `tools/check-provider-boundary.mjs` currently guards only `jellyfin.ts`; extend it to `plex.ts` in the same phase. |
| R6 | `main.ts` has 3 lines of headroom | Phase 0 frees lines before any phase adds them. Any later growth requires extraction, never a raised budget. |

**Unknowns to resolve by measurement, not discussion:** the host GPU model and
its VRAM; actual VRAM per built instance; real per-session stream bitrate; a
sensible default for `IDLE_WINDOW` (starting at 4 hours).

---

## 10. Phasing

Each phase leaves the tree working and verifiable, and **each phase gets its own
implementation plan.** This document is the architecture they all answer to; it
is deliberately not a single plan, because Phase 0 is a deletion guarded by an
existing test suite and Phase 2 is a new concurrent system, and pretending those
are one piece of work would produce a bad plan for both.

| Phase | Scope | Done when |
|---|---|---|
| **0 — Subtract** | Delete `src/flat/*`, the `bb_render_mode` branch and `device-gate.ts`; make Plex the only registered provider. | **Done.** Build gates pass, tests green, `main.ts` at 4,424/4,600. |
| **0b — Jellyfin code** | Deferred. `jellyfin.ts` is not only the Jellyfin client: ~50 files import domain types through it, and it also holds backend-agnostic helpers (`normalizeUrl`, subtitle delivery, the collection registries, HLS helpers). Deleting it properly means extracting those to neutral modules first. Unregistering the provider already achieves the Plex-only *behaviour*, so this is hygiene and was sequenced after the work that unblocks server testing. | The types move to `providers/media-source-provider.ts` (upstream already re-exports them from there for exactly this migration) and `jellyfin.ts` is deleted. |
| **1 — Front door** | New service: Plex PIN OAuth, shared-access gate, sessions, SQLite, owner detection. Gates the existing app on the LAN. No instances yet. | A non-shared Plex account is refused; a shared one reaches the store. |
| **2 — Instances** | Pool, sticky window, cap, eviction, per-session ticket seeding, per-user config via the repointed sync layer. | Two users get separate stores with separate libraries and preferences; reconnect inside the window is instant. |
| **3 — Public** | Cloudflare Tunnel, Cloudflare TURN, the full §7 lockdown. | Reachable worldwide; nothing but the front door is exposed. |
| **4 — Playback** | Control-channel handoff, minted URLs, IDLE-tier drop during playback, resume on exit. | A movie plays at full quality with the ritual intact. |
| **5 — Mobile** | Per-session viewport, portrait camera framing, portrait overlays, minimal screenshot harness. | The store is usable one-handed on a phone in portrait. |
| **6 — Tuning** | Measure VRAM and bitrate; set `INSTANCE_CAP` and `IDLE_WINDOW` from evidence; texture budget finalised. | Cap and window are set from numbers, not guesses. |

---

## 11. Configuration

New environment variables owned by the front door:

```
PLEX_MACHINE_ID       machine identifier of the gated server
OWNER_PLEX_ID         Plex account id granted admin
SESSION_SECRET        signing key for session cookies
TOKEN_ENCRYPTION_KEY  at-rest encryption for stored Plex tokens
INSTANCE_CAP          max concurrent instances (default 6)
IDLE_WINDOW_MS        how long a store stays standing (default 4h)
TURN_URL              Cloudflare TURN endpoint
TURN_CREDENTIAL       Cloudflare TURN credential
DATABASE_PATH         SQLite file location
```

The upstream `HALCYON_*` operator-defaults namespace is left alone; it is
internal, and renaming it costs a test-suite fix and every deployment doc for no
functional gain.
