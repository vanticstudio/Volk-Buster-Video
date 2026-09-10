# VolkBuster Video — working list

The running to-do for this fork. Not a changelog (CHANGELOG.md is the record of
what landed) and not a spec — this is the list of what is being built, what is
finished, and what is deliberately not being built yet.

Kept in the repo rather than in a chat window because the reason a thing is on
the list is usually the useful part, and that does not survive a scrollback.

**Status vocabulary:** `DONE` verified against a running instance, not just a
passing test · `BUILDING` in progress this session · `NEXT` designed, not
started · `PARKED` deliberately deferred, with the reason.

---

## In flight

### Mobile viewport — `BUILDING`

Framing and render budget are done (see below). What is left needs a real
phone, not arithmetic:

- **The card overlays' internals.** Seven of the nine already capped at
  90–95vw; `.genre-card`, `.version-card` and `.feedback-pin-card` did not and
  now do. Capping stops them running off the side — it does not prove their
  internal grids reflow well at 414px. Someone has to look.
- **Safe areas.** The store is `viewport-fit=cover` on the sign-in page but the
  app shell is not, so a notch or a home indicator may sit over the HUD.
- **Portrait HUD placement.** The bottom band and the touch OK/BACK buttons
  were placed against a landscape frame.

---

## Done

### The front door — `DONE`

`server/` is a Node process that owns the public port. It signs the viewer in
with Plex, checks that account has access to *this* Plex server, and only then
proxies the store. The store app itself listens on loopback and is never
directly reachable.

Gate logic is in `server/plex-gate.ts`, kept pure so it is testable without a
network: `grantsAccessTo()` fails closed on an empty machine id, matches
identifiers exactly, and requires the resource to actually provide a server.

### Plex-only — `DONE`

Jellyfin's fetch layer was repointed behind `providers/media-source-provider.ts`
(50 modules). Sign-in is Plex PIN OAuth; access follows Plex library sharing,
so there is no second list of who is allowed in to keep in sync.

### 2.5D flat mode removed — `DONE`

Deleted outright rather than hidden. It was a second rendering path that every
scene change had to be correct in, and returning `main.ts` from 3 lines of
budget headroom to 176 is what made everything since affordable.

### Rebrand to VolkBuster Video — `DONE`

Including the in-store signage, the loading screen, the CRT chrome and the
app icon — the rendered assets, not just the strings.

### Paste-and-go install — `DONE`

One `docker run` at the top of the README, pulling a multi-arch image from
GHCR. Verified anonymously pullable for both amd64 and arm64 through the
registry API.

### Management console on 3366 — `DONE`

Owner-only second port: which libraries the store stocks, whether the games
department exists, and a sign-everyone-out. Published to the LAN, never routed
in from outside — 3355 is what goes through the Cloudflare tunnel, and keeping
the console off it means a routing mistake there cannot reach it.

### Link previews — `DONE`

Open Graph and Twitter cards on the SIGN-IN page, because that is where an
unauthenticated crawler lands — a card inside the store would sit behind the
gate the crawler cannot pass. The image is generated from the brand mark
(`tools/gen-share-image.mjs`), and the absolute URL it needs is built from the
request's Host, which is allowlisted before use.

### Mobile framing and render budget — `DONE (maths), UNVERIFIED (on glass)`

The store asked for a fixed 60° **vertical** fov, which is 91.5° horizontally
at 16:9 and 29.9° on a portrait phone — a third of the view every camera
position in `store-camera.ts` was composed against. `src/viewport.ts` holds the
horizontal field constant as the aspect narrows, clamped at 80° vertical so it
does not fisheye, which puts a phone at 42.4° instead of 29.9°.

It also caps the renderer's pixel ratio at 1.5 on a handheld. The pixel BUDGET
never binds on a phone — a phone's viewport is ~330k CSS pixels against a 3.7M
budget — so the tier's own ratio cap was the only thing between a mobile GPU
and a 2x buffer, and it was set for desktops.

**Not yet seen on a phone.** The angles are unit-tested at every aspect
(`tests/viewport.test.ts`) and the wiring typechecks and builds, but nobody has
looked at the result on glass: the browser here would not come to the
foreground, and a headless boot of 2174 textures under SwiftShader does not
finish. What the numbers cannot tell you is whether 80° feels right in the
aisle. If it reads too wide, `MAX_FOV` in `src/viewport.ts` is the one number
to change, and the tests will tell you what it costs.

### Viewer mode on 3355 — `DONE`

Both system menus drop to CONTROLS & HELP, SIGN OUT, RETURN TO STORE when the
store is served through the front door. Before this, every viewer on a
tunnelled port had SUSPEND SYSTEM (sleeps the owner's NAS) and CHANGE SERVER /
LOG OUT (repoints the store's Plex connection for whoever loads it next).

---

## Next

### Render on the host, once — `NEXT`

The point of the GPU in the box is that the store is not rebuilt from scratch
every time somebody opens the website. Phase 1 (a persistent server process
that survives between visitors) is done. Phase 2 is a per-viewer rendering
instance on the host, streamed to the browser — the design is written up in
`docs/architecture/`; nothing is built.

Blocked behind Cloudflare TURN, because a WebRTC stream through the tunnel
needs a relay the tunnel does not provide.

### 30fps floor — `NEXT`

Analysed, not applied. The levers, in the order they are worth pulling:

- seed `bb_fps_cap=30`, `bb_motion_ss=0`, `bb_settle_ss=0`, `bb_px_budget=2.07`
- make `liveMirrorsAllowed()` honour `bb_mirrors=0` (today it does not)
- instance the ceiling troffers
- n8ao `transparencyAware=false` — **needs an A/B against the storefront
  glazing first**, since that is exactly the surface the flag is about

Wants a management-console toggle rather than being hard-coded, so the owner
can pick smooth-on-a-phone versus pretty-on-a-TV.

### Playback handoff — `NEXT`

Today the store streams video to the browser through the same path as the
scene. A phone would rather hand the actual playback to Plex's own client and
keep the store as the browsing surface.

---

## Parked

### `jellyfin.ts` extraction — `PARKED`

9 value-importers still reach into it directly. Mechanical, low risk, no
user-visible effect — worth doing on a quiet day, not worth blocking anything.

### Hiding libraries as access control — `PARKED, and not happening`

Worth writing down because it will get asked. The console's library toggles are
**merchandising**: they stop the store stocking a library. They do not stop a
determined viewer asking Plex for it directly with the token their own browser
holds.

Plex's own sharing is the access boundary. If someone must not see a library,
unshare it in Plex. Building a second, weaker boundary next to the real one
would mostly serve to make people trust the wrong thing.
