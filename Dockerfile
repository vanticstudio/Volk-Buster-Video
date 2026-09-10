# VolkBuster Video in a container.
#
#   docker compose up -d
#
# TWO PROCESSES, ONE PUBLIC PORT (see deploy/docker-entrypoint.sh):
#
#   store app   vite preview on 127.0.0.1:1420 — never published
#   front door  Plex gate + reverse proxy on 0.0.0.0:3355 — the only way in
#
# The store app has no authentication of any kind, so reaching it means reaching
# the whole library. Publishing only the front door is what makes the Plex gate
# mean anything. Do not map APP_PORT out of the container.
#
# Requires PLEX_MACHINE_ID, SESSION_SECRET and TOKEN_ENCRYPTION_KEY; the
# entrypoint refuses to start without them. See server/.env.example.
#
# Local mpv playback is the one host-side feature that stays off in a container.

FROM node:22-alpine
WORKDIR /app

# Chromium and coturn, for server-side rendering: Chromium is what a per-user
# rendering instance runs in, coturn relays WebRTC to viewers the host cannot
# reach directly.
#
# THIS LAYER IS ~800MB, most of the image, and nothing uses it yet. The gate
# currently proxies one shared store rendered in each viewer's own browser
# (server/app-proxy.ts); instances are the next phase. Kept because that phase
# needs exactly this, and because rebuilding it later is the same 800MB either
# way — but if image size matters more than a future phase on your NAS, this
# RUN line and the PUPPETEER_* env below are what to delete.
#
# Those private instances render the real 3D store, so they need a GPU mapped
# into the container (`--device /dev/dri`, or the devices: block in
# docker-compose.yml). Without one there is no WebGL in here at all and the
# instance manager refuses with that reason rather than spawning a browser
# that boots to nothing. Docker Desktop (macOS/Windows) can't map a GPU, so
# there use the shared mirror from a browser on the host instead.
RUN apk add --no-cache chromium coturn nss freetype harfbuzz ca-certificates ttf-freefont

# Puppeteer is a devDependency for local visual tooling; skip its own
# Chromium download (same trick as the Pages deploy workflow) and point it
# at the system one. HALCYON_CONTAINER tells the Remote Play server to pass
# the container-survival flags to Chromium.
# DATABASE_PATH is everything that must survive the container: the SQLite
# database, and instance.json beside it holding the generated signing and
# encryption keys and the chosen Plex server.
#
# Defaulted HERE rather than only in compose, because the documented install is
# a bare `docker run -v volkbuster-data:/data`. Without this the code falls back
# to ./store.db INSIDE the container, and the volume mounted at /data sits empty
# and unused. Everything would work perfectly until the container was replaced,
# at which point every session, both keys and the entire setup would vanish with
# no error and no way back.
#
# (Comments cannot live inside a line-continued instruction — Docker's handling
# of that is unreliable — hence the separate ENV below rather than folding it
# into the one above.)
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    HALCYON_CONTAINER=1
ENV DATABASE_PATH=/data/store.db

# Created so the very first boot has somewhere to write even when nothing is
# mounted at /data. A volume mount shadows this directory; its absence would
# otherwise be an ENOENT on the first write.
RUN mkdir -p /data

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .

# NO BUILD-TIME CREDENTIALS. Upstream took VITE_JELLYFIN_* build args here and
# admitted in this very comment that they "land in plain text in the served JS
# and the image layers". Vite inlines every VITE_* value into the bundle, so
# they were published strings, not secrets. The code that read them is gone and
# the args go with it — leaving them would invite the mistake back.
#
# Credentials reach this app two ways now: a viewer signs in with Plex through
# the front door, or the operator supplies them server-side via HALCYON_* env,
# which is attached per request and never enters the bundle.
RUN npm run build

# The front door only. The store app's port is deliberately not exposed.
EXPOSE 3355

# Probes the PUBLIC port, so the check fails if the gate is down even when the
# store behind it is fine. A container answering health checks while serving
# 502s is worse than one that restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD wget -qO /dev/null http://127.0.0.1:3355/healthz || exit 1

COPY deploy/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
CMD ["/usr/local/bin/entrypoint.sh"]
