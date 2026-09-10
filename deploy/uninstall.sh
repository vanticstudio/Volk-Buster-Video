#!/usr/bin/env bash
# Remove the VolkBuster systemd --user service (issue #16).
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now volkbuster.service 2>/dev/null || true
rm -f "$UNIT_DIR/volkbuster.service"
systemctl --user daemon-reload

echo "==> Removed volkbuster.service."
echo "    (Lingering, if enabled, is left as-is: sudo loginctl disable-linger \"$USER\" to undo.)"
