#!/usr/bin/env bash
# Presage's SDK builds its device ID from the Linux machine ID. Codespace containers ship without one,
# so the SDK can't download its heart-rate model and fails with
#   "device_id is required for remote model download" -> "SmartSpectra configuration failed" (error 3).
# This creates a machine ID once and keeps it. Safe to run any number of times.
set -euo pipefail
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
if [ ! -s /etc/machine-id ]; then
  tr -d '-' < /proc/sys/kernel/random/uuid | $SUDO tee /etc/machine-id > /dev/null
  echo "Created /etc/machine-id"
fi
$SUDO mkdir -p /var/lib/dbus
$SUDO ln -sf /etc/machine-id /var/lib/dbus/machine-id
echo "machine-id OK: $(cat /etc/machine-id)"
