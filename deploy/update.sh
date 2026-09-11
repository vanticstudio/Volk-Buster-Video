#!/bin/sh
# Pull the latest source, rebuild the image, and restart the app.
#
#   sudo /DATA/volkbuster-src/deploy/update.sh
#
# The whole update loop in one command, because the alternative is four
# commands each needing `sudo env DOCKER_CONFIG=...` and one of them being a
# `docker rm -f` that is easy to run against the wrong container.
#
# YOUR DATA SURVIVES. Sessions, the chosen Plex server and the generated keys
# live in a named volume, which is deliberately not touched here — the container
# is replaced, the volume is reattached. Nobody has to sign in again and setup is
# not repeated.
#
# ZimaOS note: if the app was installed through the ZimaOS UI, that UI owns the
# container. Run this to refresh the IMAGE, then hit restart in ZimaOS rather
# than letting this script recreate the container, so the two do not disagree
# about who manages it. Pass --image-only for that.
set -eu

SRC="${SRC:-/DATA/volkbuster-src}"
IMAGE="${IMAGE:-volkbuster-video:latest}"
NAME="${NAME:-volkbusters}"
PORT="${PORT:-3355}"
# The owner-only console. LAN only — never forward this one in from outside.
# Set ADMIN_PORT=0 to leave it unpublished and switched off.
ADMIN_PORT="${ADMIN_PORT:-3366}"
VOLUME="${VOLUME:-volkbuster-data}"

# ZimaOS has a read-only root filesystem, so docker cannot create its default
# config directory under /root. Everything below goes through this.
export DOCKER_CONFIG="${DOCKER_CONFIG:-/DATA/.docker}"
mkdir -p "$DOCKER_CONFIG"

IMAGE_ONLY=0
[ "${1:-}" = "--image-only" ] && IMAGE_ONLY=1

echo "==> Pulling source in $SRC"
git -C "$SRC" pull --ff-only

echo "==> Building $IMAGE"
docker build -t "$IMAGE" "$SRC"

if [ "$IMAGE_ONLY" -eq 1 ]; then
  echo "==> Image rebuilt. Restart the app in ZimaOS to pick it up."
  exit 0
fi

# The console goes to the LAN, the same way the compose files publish it, and
# never further. ADMIN_PORT=0 leaves it both unpublished and switched off.
ADMIN_PUBLISH=""
if [ "$ADMIN_PORT" != "0" ]; then
  ADMIN_PUBLISH="-p ${ADMIN_PORT}:${ADMIN_PORT}"
fi

echo "==> Replacing the $NAME container"
# One-time rename. Installs from before the container was called volkbusters
# still have one called volkbuster holding ports 3355 and 3366, and starting the
# new name beside it fails to bind. Its data lives in the volume, never in the
# container, so removing it loses nothing.
OLD=""
[ "$NAME" = "volkbusters" ] && OLD=volkbuster
# A container that ZimaOS or Compose manages is theirs to replace, not ours: they
# recreate it on the next boot, and the two copies then fight over the ports.
for c in $OLD "$NAME"; do
  case "$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null || true)" in
    ""|"<no value>") ;;
    *)
      echo "!! $c is managed by ZimaOS or Compose, so this script leaves it alone." >&2
      echo "!! Update it from there instead." >&2
      exit 1
      ;;
  esac
done
[ -n "$OLD" ] && docker rm -f "$OLD" >/dev/null 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
# ADMIN_PUBLISH is deliberately unquoted: it word-splits into two arguments, or
# expands to nothing at all when the console is off.
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --init \
  -p "${PORT}:${PORT}" \
  $ADMIN_PUBLISH \
  -e "PORT=${PORT}" \
  -e "ADMIN_PORT=${ADMIN_PORT}" \
  -e DATABASE_PATH=/data/store.db \
  -v "${VOLUME}:/data" \
  "$IMAGE" >/dev/null

echo "==> Waiting for the gate"
i=0
while [ "$i" -lt 60 ]; do
  if wget -qO /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
    echo "==> Up on :${PORT}"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "!! Did not come up in 60s. Logs:" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
