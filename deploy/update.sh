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
NAME="${NAME:-volkbuster}"
PORT="${PORT:-3355}"
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

echo "==> Replacing the $NAME container"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --init \
  -p "${PORT}:${PORT}" \
  -e "PORT=${PORT}" \
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
