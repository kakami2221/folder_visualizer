#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="folder-visualizer"
APP_USER="${APP_USER:-folderviz}"
APP_GROUP="${APP_GROUP:-folderviz}"
APP_ROOT="${APP_ROOT:-/opt/folder-visualizer}"
RELEASES_DIR="${APP_ROOT}/releases"
SHARED_DIR="${APP_ROOT}/shared"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/folder-visualizer"
LOG_DIR="/var/log/folder-visualizer"
STATIC_DIR="/srv/folder-visualizer"
PUBLIC_STATIC_DIR="${STATIC_DIR}/static"
SOURCE_DIR="${SOURCE_DIR:-$(cd "${DEPLOY_DIR}/.." && pwd)}"
APP_DOMAIN="${APP_DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"

source "${DEPLOY_DIR}/release-env.sh"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo APP_DOMAIN=example.com CERTBOT_EMAIL=you@example.com $0" >&2
  exit 1
fi

if [[ -z "${APP_DOMAIN}" || "${APP_DOMAIN}" == "example.com" ]]; then
  echo "APP_DOMAIN must be a public domain whose DNS A/AAAA record points to this EC2 instance." >&2
  exit 1
fi
if [[ ! "${APP_DOMAIN}" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "APP_DOMAIN contains unsupported characters." >&2
  exit 1
fi

if [[ ! -f "${SOURCE_DIR}/app.py" || ! -f "${SOURCE_DIR}/requirements.txt" ]]; then
  echo "SOURCE_DIR does not contain the Folder Visualizer project." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes \
  ca-certificates \
  certbot \
  curl \
  logrotate \
  nginx \
  python3 \
  python3-venv \
  rsync

if ! getent group "${APP_GROUP}" >/dev/null; then
  groupadd --system "${APP_GROUP}"
fi
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "${APP_GROUP}" \
    --home-dir "${APP_ROOT}" \
    --shell /usr/sbin/nologin \
    "${APP_USER}"
fi

install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${RELEASES_DIR}" "${SHARED_DIR}"
install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${LOG_DIR}"
install -d -m 0755 -o root -g root \
  "${CONFIG_DIR}" \
  "${STATIC_DIR}" \
  "${PUBLIC_STATIC_DIR}" \
  /var/www/certbot
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

ENV_FILE="${CONFIG_DIR}/folder-visualizer.env"
if [[ -L "${ENV_FILE}" ]]; then
  echo "Refusing to use a symlink as the application environment file." >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  install -m 0600 -o root -g root /dev/null "${ENV_FILE}"
  GENERATED_SECRET="$("${RELEASE_DIR}/.venv/bin/python" -c 'import secrets; print(secrets.token_urlsafe(64))')"
  sed \
    -e "s|^SECRET_KEY=.*|SECRET_KEY=${GENERATED_SECRET}|" \
    -e "s|^APP_BASE_URL=.*|APP_BASE_URL=https://${APP_DOMAIN}|" \
    "${RELEASE_DIR}/.env.example" >"${ENV_FILE}"
fi
chown root:"${APP_GROUP}" "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"
fv_write_app_version "${ENV_FILE}" "${TARGET_APP_VERSION}"

chown -R "${APP_USER}:${APP_GROUP}" "${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${APP_ROOT}/current"
rsync -a --delete "${RELEASE_DIR}/static/" "${PUBLIC_STATIC_DIR}/"
chown -R root:root "${PUBLIC_STATIC_DIR}"
chmod -R a=rX "${PUBLIC_STATIC_DIR}"

install -m 0644 \
  "${RELEASE_DIR}/deploy/folder-visualizer.service" \
  "/etc/systemd/system/folder-visualizer.service"
install -m 0644 \
  "${RELEASE_DIR}/deploy/folder-visualizer.logrotate" \
  "/etc/logrotate.d/folder-visualizer"
install -d -m 0755 -o root -g root /etc/letsencrypt/renewal-hooks/deploy
install -m 0755 \
  "${RELEASE_DIR}/deploy/certbot-reload-nginx.sh" \
  "/etc/letsencrypt/renewal-hooks/deploy/folder-visualizer-reload-nginx"

sed "s/example\\.com/${APP_DOMAIN}/g" \
  "${RELEASE_DIR}/nginx/bootstrap.conf" \
  >"/etc/nginx/conf.d/folder-visualizer.conf"
rm -f /etc/nginx/sites-enabled/default

systemctl daemon-reload
systemctl enable --now folder-visualizer.service
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [[ -n "${CERTBOT_EMAIL}" ]]; then
  certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --domain "${APP_DOMAIN}" \
    --email "${CERTBOT_EMAIL}" \
    --agree-tos \
    --no-eff-email \
    --non-interactive

  sed "s/example\\.com/${APP_DOMAIN}/g" \
    "${RELEASE_DIR}/nginx/default.conf" \
    >"/etc/nginx/conf.d/folder-visualizer.conf"
  nginx -t
  systemctl reload nginx
  systemctl enable --now certbot.timer
  echo "HTTPS enabled at https://${APP_DOMAIN}"
else
  echo "Application installed with temporary HTTP bootstrap configuration."
  echo "Set CERTBOT_EMAIL and follow deploy/README-EC2.md to enable HTTPS."
fi

fv_health_matches_version \
  "${TARGET_APP_VERSION}" \
  "http://127.0.0.1:8000/health"
echo "Installed release ${RELEASE_ID}."
