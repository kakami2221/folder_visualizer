#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/folder-visualizer}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/folder-visualizer}"
CONFIG_DIR="/etc/folder-visualizer"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
ARCHIVE="${BACKUP_DIR}/folder-visualizer-${TIMESTAMP}.tar.gz"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this backup with sudo." >&2
  exit 1
fi
if [[ ! -L "${APP_ROOT}/current" ]]; then
  echo "No installed release was found." >&2
  exit 1
fi

install -d -m 0700 -o root -g root "${BACKUP_DIR}"
tar \
  --create \
  --gzip \
  --dereference \
  --file "${ARCHIVE}" \
  --absolute-names \
  "${APP_ROOT}/current" \
  "${CONFIG_DIR}" \
  /etc/nginx/conf.d/folder-visualizer.conf \
  /etc/systemd/system/folder-visualizer.service
chmod 0600 "${ARCHIVE}"

echo "${ARCHIVE}"
echo "Browser IndexedDB data is local to each user and is not part of this server backup."
