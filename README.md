# VolkBuster Video

**Your Plex library, rebuilt as a walkable 1990s video rental store — rendered
on the server's GPU and streamed to whoever you've shared a library with.**

Every film you own is a case on a shelf. Browse the aisles under warm
fluorescents, pull something off the wall, flip it over and read the back of the
box, carry it to the counter and watch the clerk drop it in a bag that crinkles
around it.

It is not a menu with a skin on it. It's a store.

---

## What makes this fork different

VolkBuster Video is a fork of [Halcyon Video](https://github.com/halcyon-video/halcyon-video),
which is a single-user app: it runs in one person's browser, on one machine,
and treats the local network as trusted. This fork turns it into a small
multi-user service.

| | Upstream Halcyon | VolkBuster |
|---|---|---|
| **Rendering** | In each viewer's browser | On the host GPU, streamed over WebRTC |
| **Backends** | Jellyfin or Plex | Plex only |
| **Who gets in** | Whoever opens the page | Only accounts you've shared a Plex library with |
| **Settings** | One user's, in localStorage | Per-viewer, server-side |
| **Admin** | Anyone at the screen | Owner only, enforced server-side |
| **2.5D fallback** | Yes | Removed — weak devices get the stream instead |

The point of rendering server-side is that the store is **built once and stays
standing**. A returning viewer reattaches to a store that already exists rather
than paying the scene build again, and a phone that could never run three.js
gets the same store as the HTPC, because it only has to play video.

Full design: [`docs/architecture/2026-09-06-plex-only-streaming-fork.md`](docs/architecture/2026-09-06-plex-only-streaming-fork.md).

## How access works

There is no sign-up, no invite list and nothing to maintain. A viewer signs in
with Plex; the front door asks plex.tv whether that account can reach *this*
server, and lets them in only if it can.

That means **access follows your Plex sharing**. Share a library and they're in.
Unshare it and they're out at their next re-check. The permission already lives
in Plex, so it is not duplicated anywhere it could drift.

A valid Plex login is deliberately *not* enough — anyone can create a Plex
account in a minute. The gate asks a different question.

## Status

| Phase | State |
|---|---|
| Stream-only, 2.5D removed | Done |
| Plex-only | Done |
| Front door — Plex gate, sessions, per-user config | Done |
| Rendering instance pool | Next |
| Cloudflare Tunnel + TURN | Not started |
| Playback handoff | Not started |
| Mobile portrait framing | Not started |

Signing in works today and the gate is enforced. The store itself is not yet
served behind it — that's the instance pool.

## Running it

Needs **Node 22.6+** (the test runner uses type stripping).

```bash
npm ci
cp server/.env.example server/.env      # fill in the three required values
npm run build
npm run server
```

`PLEX_MACHINE_ID` is your server's `clientIdentifier`, from
`https://plex.tv/api/v2/resources?X-Plex-Token=YOUR_TOKEN`. The front door
refuses to start without it, `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` —
each of those fails silently and dangerously when absent, so it fails loudly
instead.

```bash
npm test            # 539 tests, no framework, about a second
npm run build       # three custom gates, then two typechecks, then vite
```

### Deployment shape

Only the front door is ever exposed. Vite and every rendering instance bind to
loopback, which makes upstream's dev middleware (`/dev-proxy`, `/__play`,
`/__feedback`) unreachable rather than merely gated — you cannot forget to
protect a port you never published.

```
Internet ──▶ cloudflared ──▶ front door :8080     ← the only public surface
              127.0.0.1 ───┬─ vite preview        ← never exposed
                           └─ rendering instances
```

## Building on it

Three custom gates run before `tsc` on every build, and they will fail you
before TypeScript does:

- **File budgets** — `src/main.ts`, `three-scene.ts` and `video-case.ts` have
  hard line ceilings. Don't raise them; extract instead. The pattern is free
  functions taking the owning object as first parameter, with a one-line
  delegating stub left on the class.
- **Provider boundary** — nothing outside `src/providers/` imports a value from
  the media-server client.
- **Signage slots** — the sign/brand manifest is validated against the catalog.

There is no linter, deliberately. The codebase uses comments as a decision log:
nearly every non-obvious constant cites an issue number or the measurement that
produced it, and several document things that were tried and are wrong. Reading
the comment above a strange-looking line is almost always faster than guessing.

## Credits

Built on [Halcyon Video](https://github.com/halcyon-video/halcyon-video) by its
authors, which is the entire reason this exists. The 3D store, the rental
ritual, the clerk, the procedural floor plan and the art pipeline are theirs.
This fork changes who it serves and where it renders.

Third-party assets keep their own terms — see `public/models/ATTRIBUTION.md`,
`public/demo-posters/ATTRIBUTION.md`, `public/demo-clip/ATTRIBUTION.md` and
`src/assets/licenses/`.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Licence

GPL-3.0, inherited from upstream and not optional — see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).

Worth knowing which half applies to you: running this as a service, even
modified, is **not** distribution under the GPL, so hosting it for your own
Plex users carries no obligation to publish anything. Handing someone a copy —
a repo, a tarball, a container image, an APK — is what brings §5 into play, and
then the modified source goes with it.
