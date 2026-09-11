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
docker run -d --name volkbusters --restart unless-stopped -p 3355:3355 -p 3366:3366 -v volkbuster-data:/data ghcr.io/vanticstudio/volk-buster-video:latest
```

**On ZimaOS**, paste this into **Install Custom App** → **YAML** tab instead. It
is the same install as the command above — same image, ports and data volume —
with the app's name and icon filled in, so ZimaOS installs it without asking for
a project name:

```yaml
name: volkbusters

services:
  volkbusters:
    image: ghcr.io/vanticstudio/volk-buster-video:latest
    container_name: volkbusters
    restart: unless-stopped
    init: true
    ports:
      - "3355:3355"
      - "3366:3366"   # the owner's console: LAN only, never forward it
    volumes:
      - volkbuster-data:/data

volumes:
  volkbuster-data:
    name: volkbuster-data   # the exact name, so an existing install keeps its data

x-casaos:
  title:
    custom: Volkbusters
    en_us: Volkbusters
  icon: https://raw.githubusercontent.com/vanticstudio/Volk-Buster-Video/refs/heads/main/deploy/icon/volkbuster-icon-512.png
  main: volkbusters
  port_map: "3355"
  scheme: http
  index: /
  category: Media
  author: self
```

ZimaOS reads the name and icon only from YAML, never from a `docker run` line. If
you use the **Docker CLI** tab anyway, set **App title** to `Volkbusters` and the
icon URL to `https://raw.githubusercontent.com/vanticstudio/Volk-Buster-Video/refs/heads/main/deploy/icon/volkbuster-icon-512.png` on the **Form** tab before installing.

Then get your setup code:

```bash
docker logs volkbusters | grep -i "setup code"
```

Open `http://<your-host>:3355`, enter the code, sign in with Plex, pick your
server. Done.

The second port, `3366`, is your management console: which libraries the store
stocks, whether the games department exists, and signing every viewer out. Open
`http://<your-host>:3366` and sign in with Plex again — it also checks that you
own the server the store gates on. **Keep it on your LAN.** `3355` is the only
port that should ever go through a tunnel or a router forward. Add
`-e ADMIN_PORT=0` to the command above, and drop its `-p 3366:3366`, if you
would rather not run it at all.

**On a NAS**, swap the volume for a real folder so you can see and back up your
data — a Docker named volume lives under `/var/lib/docker/volumes/` and will not
show up in a file browser:

```bash
docker run -d --name volkbusters --restart unless-stopped -p 3355:3355 -p 3366:3366 -v /DATA/AppData/volkbuster:/data ghcr.io/vanticstudio/volk-buster-video:latest
```

That folder holds `store.db` (sessions and per-viewer settings) and
`instance.json` (the generated keys and your chosen Plex server). Back it up
like a credential store, because that is what it is.

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

**ZimaOS, with your data in a folder you can browse:** paste
[`deploy/zimaos-compose.yml`](deploy/zimaos-compose.yml) into the YAML tab
instead of the block above. It keeps everything under
`/DATA/AppData/volkbuster` and adds a `brand` folder for your own logo. It does
not share data with the volume install, so pick one and stay with it.

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

> **Two ports, one of them public.** `3355` is the front door, and the only port
> that should ever go through a tunnel or a router forward. `3366` is the
> owner-only console: published to your LAN so you can reach it from another
> machine, never routed in from outside. The store itself runs on loopback
> inside the container and has no authentication of its own — it is reachable
> only through the front door, which checks a Plex session first. Never map port
> `1420` out of the container.

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
| **Store settings** | In the store, per browser | On the console, one shop for everyone |
| **Phones** | Renders, barely | Told to use a desktop or TV |

Each viewer sees their own access because the store's Plex connection is
resolved from *their* token — Plex only returns what that account can reach. It
is not a permission this code applies; it is what asking Plex as them returns.

### What is not built yet

The store is currently rendered in each viewer's own browser and proxied behind
the gate — one shared store, so everyone drives the same camera. The design this
is heading for renders per-viewer instances on the host GPU and streams them
over WebRTC, which is what stops the scene rebuilding on every visit. That is
the next phase, not today's behaviour.

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

## The management console

Everything about the shop is set on `:3366`, by you, once — and every viewer
gets the shop you built. The public store on `:3355` has no settings at all: its
counter terminal offers SIGN OUT and RETURN TO STORE, and nothing else.

That split is the point. `:3355` is what goes through a tunnel to everyone you
share a Plex library with, and the store's own settings page could change the
Plex connection, suspend the host, or open the staff-only service knobs. Those
are not a visitor's to touch.

The console covers:

- **Libraries** — which of your Plex libraries the store stocks.
- **The look** — era (1990 / 1993 / 2000 / 2010), shelf arrangement, wall
  colour, storefront, ceiling, what's outside the windows, media format.
- **How renting works** — carry-to-the-counter, and whether titles lock for a
  real rental period after watching.
- **Departments** — games (and 21 per-platform bays), streaming services,
  candy.
- **Playback** — audio language and default captions.
- **Sessions** — sign every viewer out at once, which is the lever you want
  right after unsharing a library.

Two things it deliberately does not do. It holds **no credentials or server
addresses** — those reach the app server-side and would be disclosed to every
viewer if the console wrote them. And it does not touch the **render settings**
(quality tier, ambient occlusion, frame cap): those describe a viewer's own
machine, and forcing your TV's settings onto someone's laptop makes their store
worse, not more consistent.

> **Hiding a library is merchandising, not access control.** It stops the store
> stocking it. It does not stop someone asking Plex for it directly with the
> token their own browser holds. Plex's sharing is the boundary — if a person
> must not see a library, unshare it there.

## Status

| Phase | State |
|---|---|
| Stream-only, 2.5D removed | Done |
| Plex-only | Done |
| Front door — Plex gate, sessions, per-user config | Done |
| Store served behind the gate; one setup for everyone | Done |
| Management console on `:3366` — libraries, departments, settings | Done |
| Viewer mode — the public store offers no settings at all | Done |
| Link previews when the store's URL is shared | Done |
| Phones turned away with a message rather than served badly | Done |
| Rendering instance pool | Next |
| Cloudflare Tunnel + TURN | Not started |
| Playback handoff | Not started |
| Plex "now playing" sessions | Not started |

Signing in works, the gate is enforced, the store is served behind it and the
owner runs it from the console. What the instance pool adds is per-viewer
rendering on the host GPU.

Two things are worth knowing before you install. **Playback does not appear in
Plex's activity dashboard** — the store reports resume position and watched
state, which is what the shelves read back, but it does not open a Plex session,
so nobody shows up as "now playing". And **phones are not supported**: the store
is a walkable 3D shop with a remote-control scheme and a scene budget written
for a TV, so a handset gets a message pointing it at a desktop or TV instead. A
tablet is fine.

The full working list, with the reasoning, is
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## How it fits together

Two processes, three ports, one of them internet-facing. The store app has no
authentication of its own, so it binds to loopback and is reachable only through
the front door, which checks a Plex session and then proxies. The management
console is published to the LAN on its own port and never further. Upstream's
dev endpoints (`/dev-proxy`, `/__play`, `/__feedback`) are removed from the
production server rather than gated — you cannot forget to protect something
that is not registered.

```
Internet ──▶ (tunnel/router) ──▶ front door :3355   ← the only way in
     LAN ──────────────────────▶ console    :3366   ← owner only, LAN only
                  127.0.0.1 ───┬─ store app :1420   ← never exposed
                               └─ rendering instances (later)
```

Development needs **Node 22.6+** (the test runner uses type stripping):

```bash
npm test            # 640 tests, no framework, about a second
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
