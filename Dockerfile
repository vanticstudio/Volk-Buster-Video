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

# Chromium renders Remote Play private instances server-side; coturn relays
# WebRTC for viewers the store can't reach directly (VPN / hostile NAT).
# This layer is ~800MB — most of the image — and it's what makes
# remote.html work on a headless server.
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
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    HALCYON_CONTAINER=1

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .

# Optional autologin baked into the bundle at build time (in-app login is the
# normal flow). NOTE: values land in plain text in the served JS and the image
# layers — only bake credentials into an image that never leaves your network.
#   docker build -t volkbuster-video \

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
