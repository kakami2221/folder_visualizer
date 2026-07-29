#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/folder-visualizer}"
RELEASES_DIR="${APP_ROOT}/releases"
APP_USER="${APP_USER:-folderviz}"
APP_GROUP="${APP_GROUP:-folderviz}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/etc/folder-visualizer/folder-visualizer.env}"
PUBLIC_STATIC_DIR="${PUBLIC_STATIC_DIR:-/srv/folder-visualizer/static}"
SOURCE_DIR="${SOURCE_DIR:-$(cd "${DEPLOY_DIR}/.." && pwd)}"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"
PREVIOUS_TARGET="$(readlink -f "${APP_ROOT}/current" || true)"

source "${DEPLOY_DIR}/release-env.sh"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this update with sudo." >&2
  exit 1
fi
if [[ ! -f "${SOURCE_DIR}/app.py" || ! -d "${RELEASES_DIR}" ]]; then
  echo "Invalid SOURCE_DIR or the initial install has not completed." >&2
  exit 1
fi
if [[ \
  -z "${PREVIOUS_TARGET}" \
  || "${PREVIOUS_TARGET}" != "${RELEASES_DIR}/"* \
  || ! -f "${PREVIOUS_TARGET}/app.py" \
]]; then
  echo "The current release target is invalid." >&2
  exit 1
fi

PREVIOUS_RELEASE_VERSION="$(fv_release_app_version "${PREVIOUS_TARGET}")"
CURRENT_ENV_VERSION="$(fv_environment_app_version "${ENV_FILE}")"
if [[ "${CURRENT_ENV_VERSION}" != "${PREVIOUS_RELEASE_VERSION}" ]]; then
  echo "The active release and environment APP_VERSION do not match." >&2
  exit 1
fi

"${APP_ROOT}/current/deploy/backup.sh"
install -d -m 0755 -o root -g root "${RELEASE_DIR}"
rsync -a \
  --exclude '.env' \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "${SOURCE_DIR}/" "${RELEASE_DIR}/"

TARGET_APP_VERSION="$(fv_release_app_version "${RELEASE_DIR}")"

python3 -m venv "${RELEASE_DIR}/.venv"
"${RELEASE_DIR}/.venv/bin/pip" install --upgrade pip
"${RELEASE_DIR}/.venv/bin/pip" install --requirement "${RELEASE_DIR}/requirements.txt"
chown -R "${APP_USER}:${APP_GROUP}" "${RELEASE_DIR}"

if ! fv_activate_release \
  "${ENV_FILE}" \
  "${APP_ROOT}/current" \
  "${RELEASE_DIR}" \
  "${TARGET_APP_VERSION}" \
  "${PREVIOUS_TARGET}" \
  "${PREVIOUS_RELEASE_VERSION}" \
  "folder-visualizer.service" \
  "http://127.0.0.1:8000/health"; then
  exit 1
fi

rsync -a --delete "${RELEASE_DIR}/static/" "${PUBLIC_STATIC_DIR}/"
chown -R root:root "${PUBLIC_STATIC_DIR}"
chmod -R a=rX "${PUBLIC_STATIC_DIR}"
systemctl reload nginx
echo "Updated to release ${RELEASE_ID}. Previous releases were retained for rollback."
