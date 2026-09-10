#!/bin/sh
# Container entrypoint: two processes, one internet-facing port.
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

# No required environment. The front door generates its own signing and
# encryption keys on first boot and keeps them beside the database, and the
# Plex server is chosen through the setup page. Both used to be pasted in here,
# which was the wrong shape: one is a job a machine does strictly better than a
# human, and the other deserved a list to pick from rather than a raw API URL.

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

echo "[entrypoint] front door -> 0.0.0.0:${PORT} (the only internet-facing port)"
# --disable-warning: node prints an ExperimentalWarning for both type
# stripping and node:sqlite on every start. Both are known and deliberate,
# and they bury the setup banner an operator is reading the log FOR.
#
# NOT `exec`. exec replaces this shell, which discards the trap above — the
# store app would then outlive the front door as an orphan still holding :1420,
# and the next start would fail --strictPort with the port already in use.
# Running it as a child keeps the trap, so both halves come down together.
node --experimental-strip-types --disable-warning=ExperimentalWarning server/index.ts &
FRONT_PID=$!
trap 'kill "$APP_PID" "$FRONT_PID" 2>/dev/null || true' EXIT INT TERM

# Exit as soon as EITHER half does. A container still listening on the public
# port with a dead store behind it answers health checks while serving 502s,
# which is worse than restarting. `wait -n` is not in POSIX sh, so fall back to
# waiting on the front door alone where busybox ash lacks it.
wait -n "$APP_PID" "$FRONT_PID" 2>/dev/null || wait "$FRONT_PID"
