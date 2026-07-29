#!/usr/bin/env sh
set -eu

# Certbot calls deploy hooks only after a certificate was renewed.
nginx -t
systemctl reload nginx
