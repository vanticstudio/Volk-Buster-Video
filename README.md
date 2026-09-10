# VolkBuster Video

**Your Plex library, rebuilt as a walkable 1990s video rental store.** Sign in
with Plex; if the owner has shared a library with you, you're in — and you see
your own access, nobody else's.

Every film you own is a case on a shelf. Browse the aisles under warm
fluorescents, pull something off the wall, flip it over and read the back of the
box, carry it to the counter and watch the clerk drop it in a bag that crinkles
around it.

It is not a menu with a skin on it. It's a store.

## Install

> **Maintainers, once:** GitHub creates a new container package **private**, and
> a private package cannot be pulled anonymously — `docker pull` returns 403 and
> looks like a broken build. After the first successful Actions run, open
> [package settings](https://github.com/users/vanticstudio/packages/container/volk-buster-video/settings)
> and set visibility to **Public**. This cannot be automated with the default
> workflow token.


```bash
docker run -d --name volkbuster --restart unless-stopped -p 3355:3355 -v volkbuster-data:/data ghcr.io/vanticstudio/volk-buster-video:latest
```

Then get your setup code:

```bash
docker logs volkbuster | grep -i "setup code"
```

Open `http://<your-host>:3355`, enter the code, sign in with Plex, pick your
server. Done.

**Nothing to clone, build, or configure.** No environment variables, no config
file, no secrets to generate. The signing and encryption keys are created on
first boot and kept beside the database; which Plex server the store gates on is
chosen in the browser from a list of the ones you own.

The setup code is asked for once. Reading it out of the log proves you control
the host, which is what stops the first stranger who finds the address from
claiming your store. It is cleared the moment setup finishes.

<details>
<summary>Docker Compose, and other ways in</summary>

```bash
curl -O https://raw.githubusercontent.com/vanticstudio/Volk-Buster-Video/main/docker-compose.yml
docker compose up -d
```

**ZimaOS / CasaOS:** Install Custom App → YAML tab → paste
[`deploy/zimaos-compose.yml`](deploy/zimaos-compose.yml) → Install.

**From source**, if you want to change it:

```bash
git clone https://github.com/vanticstudio/Volk-Buster-Video.git && cd Volk-Buster-Video
npm ci && npm run build
npm run serve &     # the store, on loopback
npm run server      # the front door, on :3355
```

`server/.env.example` exists only for deployments that manage secrets
externally. You do not need it.

</details>

> **One port, on purpose.** Only `3355` is published. The store itself runs on
> loopback inside the container and has no authentication of its own — it is
> reachable only through the front door, which checks a Plex session first.
> Never map port `1420` out of the container.

---


## What makes this fork different

VolkBuster Video is a fork of [Halcyon Video](https://github.com/halcyon-video/halcyon-video),
which is a single-user app: it runs in one person's browser, on one machine,
and treats the local network as trusted. This fork turns it into a small
multi-user service.

| | Upstream Halcyon | VolkBuster |
|---|---|---|
| **Who gets in** | Whoever opens the page | Only accounts you've shared a Plex library with |
| **Whose library** | The one the app is configured for | Each viewer's own, resolved from their Plex token |
| **Setup** | Every viewer, in their own browser | The owner, once |
| **Backends** | Jellyfin or Plex | Plex only |
| **Admin** | Anyone at the screen | Owner only, enforced server-side |
| **Dev endpoints in production** | `/dev-proxy`, `/__play`, `/__feedback` live | Removed from the production server |
| **2.5D fallback** | Yes | Removed |

Each viewer sees their own access because the store's Plex connection is
resolved from *their* token — Plex only returns what that account can reach. It
is not a permission this code applies; it is what asking Plex as them returns.

### What is not built yet

The store is currently rendered in each viewer's own browser and proxied behind
the gate — one shared store, so everyone drives the same camera. The design this
is heading for renders per-viewer instances on the host GPU and streams them
over WebRTC, which is what makes a phone able to walk the aisles and stops the
scene rebuilding on every visit. That is the next phase, not today's behaviour.

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
| Store served behind the gate; one setup for everyone | Done |
| Rendering instance pool | Next |
| Cloudflare Tunnel + TURN | Not started |
| Playback handoff | Not started |
| Mobile portrait framing | Not started |

Signing in works, the gate is enforced, and the store is served behind it. What
the instance pool adds is per-viewer rendering on the host GPU.

## How it fits together

Two processes, one public port. The store app has no authentication of its own,
so it binds to loopback and is reachable only through the front door, which
checks a Plex session and then proxies. Upstream's dev endpoints (`/dev-proxy`,
`/__play`, `/__feedback`) are removed from the production server rather than
gated — you cannot forget to protect something that is not registered.

```
Internet ──▶ (tunnel/router) ──▶ front door :3355   ← the only public surface
                  127.0.0.1 ───┬─ store app :1420   ← never exposed
                               └─ rendering instances (later)
```

Development needs **Node 22.6+** (the test runner uses type stripping):

```bash
npm test            # 558 tests, no framework, about a second
npm run build       # three custom gates, two typechecks, then vite
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
