#!/usr/bin/env bash

# Shared release/version helpers for install, update, and rollback.
# This file is sourced by scripts which already enable `set -Eeuo pipefail`.

FV_APP_VERSION_PATTERN='^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$'

fv_release_app_version() {
  local release_dir="$1"
  local example_file="${release_dir}/.env.example"
  local match_count
  local line
  local value

  if [[ ! -f "${example_file}" ]]; then
    echo "The target release has no .env.example." >&2
    return 1
  fi

  match_count="$(grep -Ec '^APP_VERSION=' "${example_file}" || true)"
  if [[ "${match_count}" != "1" ]]; then
    echo "The target release must define APP_VERSION exactly once." >&2
    return 1
  fi

  line="$(grep -E '^APP_VERSION=' "${example_file}")"
  line="${line%$'\r'}"
  value="${line#APP_VERSION=}"
  if [[ ! "${value}" =~ ${FV_APP_VERSION_PATTERN} ]]; then
    echo "The target release has an invalid APP_VERSION." >&2
    return 1
  fi

  printf '%s\n' "${value}"
}

fv_environment_app_version() {
  local env_file="$1"
  local match_count
  local line
  local value

  if [[ ! -f "${env_file}" || -L "${env_file}" ]]; then
    echo "The application environment file is missing or unsafe." >&2
    return 1
  fi

  match_count="$(grep -Ec '^APP_VERSION=' "${env_file}" || true)"
  if [[ "${match_count}" != "1" ]]; then
    echo "The application environment must define APP_VERSION exactly once." >&2
    return 1
  fi

  line="$(grep -E '^APP_VERSION=' "${env_file}")"
  line="${line%$'\r'}"
  value="${line#APP_VERSION=}"
  if [[ ! "${value}" =~ ${FV_APP_VERSION_PATTERN} ]]; then
    echo "The application environment has an invalid APP_VERSION." >&2
    return 1
  fi

  printf '%s\n' "${value}"
}

fv_write_app_version() {
  local env_file="$1"
  local value="$2"
  local env_dir
  local temp_file
  local reference_owner
  local temp_owner

  if [[ ! "${value}" =~ ${FV_APP_VERSION_PATTERN} ]]; then
    echo "Refusing to write an invalid APP_VERSION." >&2
    return 1
  fi
  if [[ ! -f "${env_file}" || -L "${env_file}" ]]; then
    echo "The application environment file is missing or unsafe." >&2
    return 1
  fi

  env_dir="$(dirname -- "${env_file}")"
  temp_file="$(mktemp "${env_dir}/.folder-visualizer.env.XXXXXX")"

  if ! awk -v app_version="${value}" '
    BEGIN {
      replaced = 0
    }
    /^[[:space:]]*APP_VERSION[[:space:]]*=/ {
      if (!replaced) {
        print "APP_VERSION=" app_version
        replaced = 1
      }
      next
    }
    {
      print
    }
    END {
      if (!replaced) {
        print "APP_VERSION=" app_version
      }
    }
  ' "${env_file}" >"${temp_file}"; then
    rm -f -- "${temp_file}"
    return 1
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    if ! chown --reference="${env_file}" "${temp_file}"; then
      rm -f -- "${temp_file}"
      return 1
    fi
  else
    reference_owner="$(stat -c '%u:%g' "${env_file}")"
    temp_owner="$(stat -c '%u:%g' "${temp_file}")"
    if [[ "${reference_owner}" != "${temp_owner}" ]]; then
      echo "Only root may replace an environment file owned by another user." >&2
      rm -f -- "${temp_file}"
      return 1
    fi
  fi

  if ! chmod --reference="${env_file}" "${temp_file}"; then
    rm -f -- "${temp_file}"
    return 1
  fi
  if ! mv -fT -- "${temp_file}" "${env_file}"; then
    rm -f -- "${temp_file}"
    return 1
  fi
}

fv_health_matches_version() {
  local expected_version="$1"
  local health_url="$2"
  local payload

  if [[ ! "${expected_version}" =~ ${FV_APP_VERSION_PATTERN} ]]; then
    return 1
  fi
  if ! payload="$(
    curl --fail --silent --show-error --retry 10 --retry-delay 1 "${health_url}"
  )"; then
    return 1
  fi

  EXPECTED_APP_VERSION="${expected_version}" \
    python3 -c '
import json
import os
import sys

payload = json.load(sys.stdin)
valid = (
    payload.get("status") == "ok"
    and payload.get("version") == os.environ["EXPECTED_APP_VERSION"]
)
raise SystemExit(0 if valid else 1)
' <<<"${payload}" >/dev/null 2>&1
}

fv_activate_release() {
  local env_file="$1"
  local current_link="$2"
  local target_release="$3"
  local target_version="$4"
  local previous_release="$5"
  local previous_version="$6"
  local service_name="$7"
  local health_url="$8"
  local transition_failed=0
  local restore_failed=0

  # The environment namespace is ready before the new process can start.
  if ! fv_write_app_version "${env_file}" "${target_version}"; then
    return 1
  fi
  if ! ln -sfn "${target_release}" "${current_link}"; then
    echo "Could not switch the release link." >&2
    transition_failed=1
  elif ! systemctl restart "${service_name}"; then
    echo "Could not restart the target release." >&2
    transition_failed=1
  elif ! fv_health_matches_version "${target_version}" "${health_url}"; then
    echo "The target release failed its versioned health check." >&2
    transition_failed=1
  fi

  if [[ "${transition_failed}" -eq 0 ]]; then
    return 0
  fi

  echo "Restoring the previous release and environment version." >&2
  if ! fv_write_app_version "${env_file}" "${previous_version}"; then
    echo "Could not restore the previous environment version." >&2
    restore_failed=1
  fi
  if ! ln -sfn "${previous_release}" "${current_link}"; then
    echo "Could not restore the previous release link." >&2
    restore_failed=1
  fi
  if ! systemctl restart "${service_name}"; then
    echo "Could not restart the previous release." >&2
    restore_failed=1
  elif ! fv_health_matches_version "${previous_version}" "${health_url}"; then
    echo "The restored release did not pass its versioned health check." >&2
    restore_failed=1
  fi

  if [[ "${restore_failed}" -ne 0 ]]; then
    echo "Automatic restoration was incomplete; manual recovery is required." >&2
  fi
  return 1
}
