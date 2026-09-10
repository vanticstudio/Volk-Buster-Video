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

### Social link previews — `BUILDING`

Sharing the store's URL currently produces a bare link: no title card, no
image. The tunnel URL is what gets pasted into a Discord DM or a group chat
when the owner invites someone, so that preview is the store's front window
for people who have not seen it yet.

Needs Open Graph + Twitter card meta and a 1200×630 share image. The image has
to be generated from the store's own brand assets rather than screenshotted, so
it stays right when the brand pack changes.

### Mobile viewport — `BUILDING`

The store renders at a fixed 60° **vertical** field of view. On a landscape
desktop that frames an aisle; on a portrait phone (aspect ~0.46) the horizontal
field collapses to a sliver and the visitor is looking at one shelf edge. This
is the "renders 16:9 on mobile" problem.

The fix is a horizontal-FOV lock: below a reference aspect, widen the vertical
FOV so the horizontal field stays constant. A phone then sees the same *width*
of store as a desktop, with more height, which is what a portrait screen is
for.

Touch input already exists (`src/store-touch.ts`, #126) — swipe to browse, an
on-screen OK and BACK. What is missing is the framing, and a phone-sized
render budget so the thing is smooth on the device rather than merely visible.

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
department exists, and a sign-everyone-out. Never published — 3355 is what goes
through the Cloudflare tunnel, and a port that is not published cannot be
exposed by a routing mistake.

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
