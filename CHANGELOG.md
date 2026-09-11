# Changelog

All notable changes to VolkBuster Video.

Hand-maintained, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
order. Upstream generated this file from commit subjects with
`tools/release-notes.mjs`; that tool fanned releases out to upstream's own
Discord and social accounts and was removed with the rest of its release
machinery, so entries are written here deliberately.

VolkBuster Video is a fork of [Halcyon Video](https://github.com/halcyon-video/halcyon-video),
taken at upstream **v0.15.0** (2026-09-04). Upstream's own history before that
point is not reproduced here. See [`NOTICE`](NOTICE) for the GPL-3.0
modification notice.

---

## [Unreleased]

The fork's first stretch of work: turning a single-user local client into a
small multi-user service, and making it ours.

### Security

- **Credentials could no longer be compiled into the shipped bundle.** Vite
  substitutes every `VITE_*` value into `dist/assets/main-*.js` at build time,
  so upstream's `VITE_JELLYFIN_PASSWORD`, `VITE_ROMM_APIKEY` and the
  `VITE_*SEERR_APIKEY` values were never secrets — they were published strings,
  readable from devtools. Upstream's own log line said so: "the API key ships
  inside the bundle: anyone using this store can read it." Every credential read
  is gone, along with `.env.local.example`, which invited the pattern.

  The leak that mattered most was not any of those. `settings.ts` looked up
  ``VITE_${key.toUpperCase()}`` with a **computed** key, and Vite can only
  substitute members it sees literally — so a computed lookup forced it to
  inline the *entire* env object. Removing the literal reads did not stop the
  leak; that one line was still publishing all of them. Verified by building
  with canary values and grepping `dist/`.

- **`.gitignore` carried no `.env` or `*.db` rule.** A first public push would
  have committed `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` and a database of
  encrypted Plex tokens, and git history keeps secrets after deletion.

- Removed a dead password re-authentication branch this exposed: the function
  purges `jellyfin_password` on entry, so with the env value gone both operands
  were always null.

### Added

- **Every store setting is now set on the management console**, not in the store:
  28 of them plus 21 per-platform game toggles, covering the era, shelf
  arrangement, wall colour, storefront, ceiling, what is outside, media format,
  how renting works, departments and playback. They are **enforced** — the owner
  builds one shop and every viewer gets it.

  Credentials, server addresses and the per-device render knobs (`bb_quality`,
  `bb_ao`, `bb_fps_cap`, `bb_fps_meter`) are deliberately excluded, each with its
  reason recorded: the first two would be disclosed to every viewer, and the last
  describe someone's own machine rather than the shop.

- **The store opens in the 2010 era** by default. That default had been written
  in two modules that cannot import each other, each with its own literal, so a
  fresh store could resolve one era's palette against another era's logo; both
  now read one constant.

- **Phones are told to use a desktop or TV** rather than served a store they
  cannot use. It takes two signals — phone-shaped and touch-primary — so a
  narrowed desktop window and a touchscreen laptop both still get the store.

- **The store is now served behind the gate.** The front door reverse-proxies
  the app for authenticated requests, so every byte of the store arrives through
  a request that already carried a valid session. Before this the two processes
  were disconnected: the only way to actually see the store was to expose the
  app port directly, which is a media library on the open internet with no gate
  at all. This proxies ONE SHARED store to every viewer and is not the per-user
  instance design — it is a usable thing to run today, and instances replace it.

- **One public port, 3355.** The store app moved to loopback behind it.

- **A management console on port 3366.** Owner-only, published to the LAN and
  never routed in from outside — 3355 is the port that goes through the
  Cloudflare tunnel, so keeping the console off it means a routing mistake
  there cannot reach the console. It
  still authenticates with the same Plex gate plus an owner check, because a LAN
  is not a trust boundary.

  It sets which Plex libraries the store stocks, whether the games department
  exists, and can sign every viewer out at once. Policy is expressed as the
  app's OWN settings keys, injected into the page on each load, so the store
  applies it without needing to know a front door exists.

  **This is merchandising, not access control.** Hiding a library stops the
  store stocking it; it does not stop someone asking Plex for it directly with
  the token their own browser holds. Plex's sharing is the boundary.

- **Viewer mode.** Served through the front door, both system menus drop to
  CONTROLS & HELP, SIGN OUT and RETURN TO STORE. Before this every viewer on a
  tunnelled port was offered SUSPEND SYSTEM — which sleeps the owner's NAS —
  and CHANGE SERVER / LOG OUT, which repoints the store's Plex connection for
  whoever loads it next.

- **A link preview.** Pasting the store's URL into a chat now unfurls a card
  instead of a bare link. It lives on the SIGN-IN page, because that is where an
  unauthenticated crawler lands; a card inside the store would sit behind the
  gate the crawler cannot pass. The image is rendered from the brand mark rather
  than screenshotted, and the absolute URL it needs is built from the request's
  Host, allowlisted before use.

  `noindex` stays: a card in a chat window is a person being invited, a search
  result is a stranger finding the login page for someone's private library.


- **A front door service (`server/`)** — the only process this deployment
  exposes. Plex PIN sign-in, an access gate that asks plex.tv whether an account
  can reach *this* server, HMAC-signed sessions, AES-256-GCM token storage at
  rest, and per-user configuration with owner-only keys enforced server-side
  rather than merely hidden in the UI. No new runtime dependencies: `node:sqlite`,
  `fetch` and webcrypto are all built in.

  Access follows Plex library sharing and is revoked the same way. A valid Plex
  login is deliberately not enough — anyone can create a Plex account.

- **A sign-in page**, self-hosted fonts and all, with a per-caller rate limit on
  the one endpoint that is both unauthenticated and calls out to plex.tv.

- `tools/gen-cover-thumbs.mjs` and `tools/thumb-harness.html`, replacing
  upstream's absent `gen_setting_thumbs.mjs` for the cover previews that carry
  the wordmark. It renders from `COVER_VARIANTS`, the same table the settings
  drawer builds its cycle from, so a variant cannot be offered without a
  thumbnail.

- `docs/architecture/2026-09-06-plex-only-streaming-fork.md`, the design this
  work answers to.

### Changed

- **Rebranded to VolkBuster Video**, including the surfaces the brand pipeline
  does not reach: the inline SVG mark in `index.html`, the favicon, the static
  chrome, and the in-world prose defaults. Both marks now pin their wordmark
  width so a ten-letter name clears the keyline before Archivo Black loads.

- **Plex is the only registered provider.** The registry stays at one entry
  rather than being inlined: it is the only build-enforced boundary in the
  codebase, and it is what keeps backend specifics out of the store's own code.

- Repointed 50 modules from `jellyfin.ts` to the provider contract at
  `providers/media-source-provider.ts`, which upstream already re-exported them
  from for exactly this migration. Nine value-importers remain.

- A theme change is now a scene rebuild rather than a full page reload. That
  escalation existed only because the mom-and-pop entry changed the store
  FORMAT, which is resolved at module evaluation.

- **The store aims at a steady 30 FPS and no longer supersamples.** It used to
  aim at 60 on capable hardware and render twice the pixels while moving: a
  10.9 MP drawing buffer on a Retina M4 Pro, pushed through the bloom chain on
  every frame of a section change. `STORE_TARGET_FPS`, `STORE_MOTION_SS` and
  `STORE_SETTLE_SS` in `display-hz.ts` hold the defaults, and an explicit
  `bb_fps_cap`, `bb_motion_ss` or `bb_settle_ss` still wins. The cost is that a
  parked frame renders at native resolution, which is sharp on a Retina panel.

- **A viewer's browser no longer keeps a CPU copy of the high-res poster
  bank**: 300 MiB on a 2,048-layer driver, 328 MiB on 4,096+. The copy exists so
  a scene rebuild can re-upload every poster at once, and a viewer can never
  trigger a rebuild. The owner's desktop keeps it. Computed from the
  allocation; not yet measured on a real boot.

- **Decoded cover art is byte-capped** instead of kept for the whole session:
  96 MiB of shelf backdrops and 16 MiB each for episode stills and season
  posters, evicting whatever was viewed longest ago. This bounds a long browse
  rather than lowering the starting footprint.

- **ZimaOS installs the app as Volkbusters, with its icon.** ZimaOS reads the
  title and icon only from a top-level `x-casaos` block, and
  `deploy/zimaos-compose.yml` had its block inside the service with no title,
  so an install stopped at "Resolve YAML placeholder before saving". The block
  is at the top level now. A `docker run` line has nowhere to carry either
  value, so the README also gives a filled-in YAML that is the same install as
  its command. The container is `volkbusters`; the `volkbuster-data` volume and
  `/DATA/AppData/volkbuster` keep their names, so no data moves.

### Removed

- **The 2.5D DOM store and the device gate.** In a stream-only build a viewer's
  browser plays video and sends input — it never renders the store, so it does
  not need WebGL2 at all. Returned `src/main.ts` from 3 lines of budget headroom
  to 176. The WebGL2 probe survives as `src/webgl-support.ts`, now a diagnostic
  telling a GPU-less container why it cannot render.

- **The mom-and-pop store format** — a second complete set of geometry
  constants, and with it the `bb_theme`/`bb_store_format` lockstep, the
  hand-lettered sign idiom, the aisle-vantage camera and the media-release-date
  exemption.

- **Upstream's release and social automation**: the announce workflows and
  tools that fanned out to upstream's Discord, Mastodon, Bluesky and X, and the
  GitHub Pages demo deploy. Also the click-to-start desktop launchers, Tauri
  icon sets for mobile targets that are not built, `harness-params.ts` (proven
  dead — the harness that drove it is absent from this checkout), and 16.5 MB of
  upstream-branded screenshots the rewritten README no longer references.

- The tip jar's donation URL, which upstream shipped pointing at the original
  author's Ko-fi, rendered as a QR code on the 3D counter, and **enabled by
  default**.

### Fixed

- **The public store leaked its whole settings drawer through CONTROLS & HELP.**
  The row looked harmless — a reference card with no knobs — but it opens the
  settings drawer on its Controls page, and Back from any page regenerates the
  drawer as the full category index. One press of Escape on a help screen and a
  viewer on the tunnelled port was in Store Look, Connection and Performance.
  The row is gone and `openSettingsDrawer()` refuses outright in viewer mode,
  because every door in that drawer opens onto the same room.

- **The 2010 store had no return chute**, so walking back in with rentals blinked
  them out of your hands with no drop ritual. It was gated to the VHS eras;
  nothing needed reshaping to lift that, since a DVD case is the same height and
  half the thickness of a VHS one and posts through the existing slot.

- **The store framed itself for a 16:9 screen and nothing else.** three.js's
  camera fov is the VERTICAL angle, and a fixed 60° is 91.5° horizontally at
  16:9 but only 29.9° on a portrait phone — a third of the view every camera
  position was composed against, so a phone visitor was looking at the shop
  through a mail slot. The horizontal field is now held constant as the aspect
  narrows (clamped at 80° vertical, since a store full of straight verticals is
  exactly the scene a fisheye ruins), putting a phone at 42.4°. Nothing changes
  at 16:9 or wider.

- **A phone was being asked to render a 2x buffer.** The pixel budget solves for
  a multiplier against ~3.7M pixels, and a phone's viewport is ~330k CSS pixels,
  so the budget never binds there — the tier's own pixel-ratio cap did, and it
  was written for desktops. Handhelds now cap at 1.5.

- **Three card overlays ran off the side of a phone.** `.genre-card`,
  `.version-card` and `.feedback-pin-card` had fixed pixel widths with no cap;
  the other six already had one. `.version-card` is the 4K/1080p picker, which
  is viewer-facing.

- **Puppeteer is pinned to `~25.2.0`, patch-only, deliberately.** Updating it to
  25.10 made it demand a Chrome build that will not download in this
  environment, which broke `tools/gen-cover-thumbs.mjs` — a caret range would
  let a routine `npm update` walk into that again. It is a dev-only tool
  dependency; there is nothing to gain from tracking its majors.


- `setup-failure-report.ts` reported version 0.11.1 while `package.json` was at
  0.15.0, so every report a user filed named a build four releases old.

- The DVD `blue` cover variant has always been offered in the settings drawer
  with no preview image at all. It has one now.

- **Moving through the store ran at 3-5 FPS on capable machines**, an M4 Pro
  and a 12th-gen i5, and slowed the whole computer. The resolution scaler,
  meant to protect frame rate, caused it. A section change dipped, the scaler
  stepped resolution down, and the resize rebuilt all 15 render targets
  synchronously. The scaler then counted that stall as a slow GPU and stepped
  down again, all the way to the 0.5 floor, leaving the store stuttering and
  blurry at once. A resize now gets a one-second grace before the scaler
  measures again. With that and the new defaults above, headless on the M4 Pro
  through 20 section changes: 28.4 composites a second, up from 14.2, and no
  main-thread blocks, down from 15 totalling 2.2 s.

### Known

- **The 30 FPS figures are from headless Chromium** on the M4 Pro, against the
  941-title demo. The live store carries 2,174 titles, a real window's frame
  timing is not headless Chromium's, and the 12th-gen i5 has not been
  re-measured.

- A latent bug inherited from upstream, not yet fixed: tearing down the flat
  store removed the search overlay from the DOM without clearing the module's
  reference to it, wedging navigation until reload. The flat store is gone, so
  the bug is unreachable — recorded in case any of that code is ever revived.

- `src/jellyfin.ts` still exists. Roughly 990 of its 1750 lines are the Jellyfin
  HTTP client; the rest are backend-agnostic helpers (`normalizeUrl`, subtitle
  delivery, the collection registries, HLS helpers) that nine files still import
  by value. Deleting it needs those extracted first.

- The mobile framing is unverified on an actual phone. The angles are
  unit-tested at every aspect ratio and the build is clean, but nobody has
  looked at the result on glass. Whether an 80° vertical fov feels right
  standing in the aisle is not a question numbers answer; `MAX_FOV` in
  `src/viewport.ts` is the single knob if it reads too wide.

- The card overlays are capped to the viewport width but their internal
  layouts have not been checked at 414px, and the app shell does not declare
  `viewport-fit=cover`, so a notch may sit over the HUD. See
  [`docs/ROADMAP.md`](docs/ROADMAP.md).

- Per-viewer rendering instances are still the next phase. What ships today
  proxies ONE SHARED store, rendered in each viewer's own browser.
