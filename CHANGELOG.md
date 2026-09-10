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

- `setup-failure-report.ts` reported version 0.11.1 while `package.json` was at
  0.15.0, so every report a user filed named a build four releases old.

- The DVD `blue` cover variant has always been offered in the settings drawer
  with no preview image at all. It has one now.

### Known

- A latent bug inherited from upstream, not yet fixed: tearing down the flat
  store removed the search overlay from the DOM without clearing the module's
  reference to it, wedging navigation until reload. The flat store is gone, so
  the bug is unreachable — recorded in case any of that code is ever revived.

- `src/jellyfin.ts` still exists. Roughly 990 of its 1750 lines are the Jellyfin
  HTTP client; the rest are backend-agnostic helpers (`normalizeUrl`, subtitle
  delivery, the collection registries, HLS helpers) that nine files still import
  by value. Deleting it needs those extracted first.

- The store is not yet served behind the gate. Signing in works; rendering
  instances are the next phase.
