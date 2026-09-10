#!/bin/sh
# Container entrypoint: two processes, one public port.
#
#   store app   vite preview, bound to 127.0.0.1 — NEVER published
#   front door  Plex gate + reverse proxy, bound to 0.0.0.0:$PORT
#
# The binding is the security boundary. The store app has no authentication of
# any kind: reaching it means reaching the whole library. Keeping it on loopback
# means the only route in is through the front door, which checks a session
# first — you cannot forget to protect a port that was never published.
#
# Both run under `set -e` with a trap, so if either dies the container exits and
# the restart policy takes over. A container still listening on 3355 with a dead
# store behind it would answer health checks while serving 502s.
set -eu

: "${PORT:=3355}"
: "${APP_PORT:=1420}"
export APP_ORIGIN="http://127.0.0.1:${APP_PORT}"

for required in PLEX_MACHINE_ID SESSION_SECRET TOKEN_ENCRYPTION_KEY; do
  eval "value=\${$required:-}"
  if [ -z "$value" ]; then
    echo "FATAL: $required is not set. See server/.env.example." >&2
    echo "Generate the two secrets with:" >&2
    echo "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" >&2
    exit 1
  fi
done

echo "[entrypoint] store app  -> 127.0.0.1:${APP_PORT} (loopback only)"
npx vite preview --port "$APP_PORT" --strictPort --host 127.0.0.1 &
APP_PID=$!

# Stop the whole container if either half dies, rather than limping.
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT INT TERM

# Wait for the store before the gate starts accepting traffic, so the first
# viewer through does not meet a 502.
i=0
while [ "$i" -lt 60 ]; do
  if wget -qO /dev/null "http://127.0.0.1:${APP_PORT}/" 2>/dev/null; then break; fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "FATAL: the store app exited during startup." >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

echo "[entrypoint] front door -> 0.0.0.0:${PORT} (the only public port)"
exec node --experimental-strip-types server/index.ts
