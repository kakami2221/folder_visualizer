#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/folder-visualizer}"
RELEASES_DIR="${APP_ROOT}/releases"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/etc/folder-visualizer/folder-visualizer.env}"
PUBLIC_STATIC_DIR="${PUBLIC_STATIC_DIR:-/srv/folder-visualizer/static}"
REQUESTED_RELEASE="${1:-}"
CURRENT_TARGET="$(readlink -f "${APP_ROOT}/current" || true)"

source "${DEPLOY_DIR}/release-env.sh"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this rollback with sudo." >&2
  exit 1
fi
if [[ \
  -z "${CURRENT_TARGET}" \
  || "${CURRENT_TARGET}" != "${RELEASES_DIR}/"* \
  || ! -f "${CURRENT_TARGET}/app.py" \
]]; then
  echo "The current release target is invalid." >&2
  exit 1
fi

CURRENT_RELEASE_VERSION="$(fv_release_app_version "${CURRENT_TARGET}")"
CURRENT_ENV_VERSION="$(fv_environment_app_version "${ENV_FILE}")"
if [[ "${CURRENT_ENV_VERSION}" != "${CURRENT_RELEASE_VERSION}" ]]; then
  echo "The active release and environment APP_VERSION do not match." >&2
  exit 1
fi

if [[ -n "${REQUESTED_RELEASE}" ]]; then
  TARGET="$(realpath -e "${RELEASES_DIR}/${REQUESTED_RELEASE}" 2>/dev/null || true)"
else
  TARGET="$(
    find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d -print \
      | sort -r \
      | grep -Fvx "${CURRENT_TARGET}" \
      | head -n 1 \
      || true
  )"
fi

if [[ -z "${TARGET}" || "${TARGET}" != "${RELEASES_DIR}/"* || ! -f "${TARGET}/app.py" ]]; then
  echo "A valid release under ${RELEASES_DIR} was not found." >&2
  exit 1
fi

TARGET_APP_VERSION="$(fv_release_app_version "${TARGET}")"

if ! fv_activate_release \
  "${ENV_FILE}" \
  "${APP_ROOT}/current" \
  "${TARGET}" \
  "${TARGET_APP_VERSION}" \
  "${CURRENT_TARGET}" \
  "${CURRENT_RELEASE_VERSION}" \
  "folder-visualizer.service" \
  "http://127.0.0.1:8000/health"; then
  exit 1
fi

rsync -a --delete "${TARGET}/static/" "${PUBLIC_STATIC_DIR}/"
chown -R root:root "${PUBLIC_STATIC_DIR}"
chmod -R a=rX "${PUBLIC_STATIC_DIR}"
echo "Rolled back to $(basename "${TARGET}")."
