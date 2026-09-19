#!/usr/bin/env bash
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently supports Debian/Ubuntu systems with apt-get."
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Run as root or install sudo first."
    exit 1
  fi
fi

$SUDO apt-get update
$SUDO apt-get install -y xvfb x11vnc xauth dbus-x11

echo
echo "Remote login system packages installed."
echo "Next: npm install"
echo "Then enable REMOTE_LOGIN_ENABLED=true and set DASHBOARD_TOKEN in .env."
