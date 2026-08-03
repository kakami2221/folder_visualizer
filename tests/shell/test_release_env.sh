#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${PROJECT_ROOT}/deploy/release-env.sh"

fail() {
  echo "release-env test failed: $1" >&2
  exit 1
}

TEMP_ROOT="$(mktemp -d)"
cleanup() {
  if [[ -n "${TEMP_ROOT:-}" && -d "${TEMP_ROOT}" ]]; then
    rm -rf -- "${TEMP_ROOT}"
  fi
}
trap cleanup EXIT

release_dir="${TEMP_ROOT}/release"
invalid_release_dir="${TEMP_ROOT}/invalid-release"
fake_bin="${TEMP_ROOT}/bin"
env_file="${TEMP_ROOT}/folder-visualizer.env"
mkdir -p "${release_dir}" "${invalid_release_dir}" "${fake_bin}"

printf '%s\n' \
  'FLASK_ENV=production' \
  'APP_VERSION=1.2.3+build.4' \
  >"${release_dir}/.env.example"
printf '%s\n' \
  'APP_VERSION=../unsafe' \
  >"${invalid_release_dir}/.env.example"
printf '%s\n' \
  'SECRET_KEY=keep-this-value-verbatim' \
  'APP_VERSION=1.0.0' \
  'LOG_LEVEL=INFO' \
  >"${env_file}"
chmod 0640 "${env_file}"

release_version="$(fv_release_app_version "${release_dir}")"
[[ "${release_version}" == "1.2.3+build.4" ]] \
  || fail "safe release version was not read"
if fv_release_app_version "${invalid_release_dir}" >/dev/null 2>&1; then
  fail "unsafe release version was accepted"
fi

mode_before="$(stat -c '%a' "${env_file}")"
owner_before="$(stat -c '%u:%g' "${env_file}")"
inode_before="$(stat -c '%i' "${env_file}")"
write_output="$(
  fv_write_app_version "${env_file}" "${release_version}" 2>&1
)"
[[ -z "${write_output}" ]] || fail "successful write logged environment values"

[[ "$(fv_environment_app_version "${env_file}")" == "${release_version}" ]] \
  || fail "environment version was not replaced"
grep -Fqx 'SECRET_KEY=keep-this-value-verbatim' "${env_file}" \
  || fail "SECRET_KEY changed"
grep -Fqx 'LOG_LEVEL=INFO' "${env_file}" \
  || fail "unrelated environment value changed"
[[ "$(grep -Ec '^APP_VERSION=' "${env_file}")" == "1" ]] \
  || fail "APP_VERSION was not normalized to one entry"
[[ "$(stat -c '%a' "${env_file}")" == "${mode_before}" ]] \
  || fail "environment mode changed"
[[ "$(stat -c '%u:%g' "${env_file}")" == "${owner_before}" ]] \
  || fail "environment owner changed"
[[ "$(stat -c '%i' "${env_file}")" != "${inode_before}" ]] \
  || fail "environment replacement was not atomic"
if compgen -G "${TEMP_ROOT}/.folder-visualizer.env.*" >/dev/null; then
  fail "temporary environment file was left behind"
fi

ln -s "${env_file}" "${TEMP_ROOT}/linked.env"
if [[ -L "${TEMP_ROOT}/linked.env" ]]; then
  if fv_write_app_version \
    "${TEMP_ROOT}/linked.env" \
    "${release_version}" \
    >/dev/null 2>&1; then
    fail "symlink environment file was accepted"
  fi
fi

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '"'"'{"status":"ok","version":"%s"}\n'"'"' "${FAKE_HEALTH_VERSION}"' \
  >"${fake_bin}/curl"
chmod 0755 "${fake_bin}/curl"

if ! PATH="${fake_bin}:${PATH}" \
  FAKE_HEALTH_VERSION="${release_version}" \
  fv_health_matches_version "${release_version}" "http://health.test/health"; then
  fail "matching health version was rejected"
fi
if PATH="${fake_bin}:${PATH}" \
  FAKE_HEALTH_VERSION="9.9.9" \
  fv_health_matches_version "${release_version}" "http://health.test/health"; then
  fail "mismatched health version was accepted"
fi

previous_release="${TEMP_ROOT}/previous-release"
target_release="${TEMP_ROOT}/target-release"
link_state="${TEMP_ROOT}/active-release"
mkdir -p "${previous_release}" "${target_release}"
fv_write_app_version "${env_file}" "1.0.0"
printf '%s\n' "${previous_release}" >"${link_state}"

ln() {
  [[ "$1" == "-sfn" ]] || fail "unexpected ln arguments"
  printf '%s\n' "$2" >"${link_state}"
}

systemctl() {
  [[ "$1" == "restart" && "$2" == "folder-visualizer.service" ]] \
    || fail "unexpected systemctl arguments"
}

health_calls=0
fv_health_matches_version() {
  local expected_version="$1"
  health_calls=$((health_calls + 1))
  if [[ "${health_calls}" -eq 1 ]]; then
    [[ "${expected_version}" == "2.0.0" ]] \
      || fail "target health check used the wrong version"
    [[ "$(fv_environment_app_version "${env_file}")" == "2.0.0" ]] \
      || fail "target health check ran before the version switch"
    [[ "$(cat "${link_state}")" == "${target_release}" ]] \
      || fail "target health check ran before the release switch"
    return 1
  fi

  [[ "${expected_version}" == "1.0.0" ]] \
    || fail "restored health check used the wrong version"
  [[ "$(fv_environment_app_version "${env_file}")" == "1.0.0" ]] \
    || fail "old version was not restored before restart verification"
  [[ "$(cat "${link_state}")" == "${previous_release}" ]] \
    || fail "old release link was not restored"
}

transition_log="${TEMP_ROOT}/transition.log"
if fv_activate_release \
  "${env_file}" \
  "${TEMP_ROOT}/current" \
  "${target_release}" \
  "2.0.0" \
  "${previous_release}" \
  "1.0.0" \
  "folder-visualizer.service" \
  "http://health.test/health" \
  >"${transition_log}" 2>&1; then
  fail "failed target health check reported a successful activation"
fi
transition_output="$(<"${transition_log}")"
[[ "${health_calls}" == "2" ]] || fail "restored release was not health checked"
[[ "$(fv_environment_app_version "${env_file}")" == "1.0.0" ]] \
  || fail "failed activation did not restore APP_VERSION"
grep -Fqx 'SECRET_KEY=keep-this-value-verbatim' "${env_file}" \
  || fail "failed activation changed SECRET_KEY"
[[ "${transition_output}" != *"2.0.0"* && "${transition_output}" != *"1.0.0"* ]] \
  || fail "activation logs exposed version values"

echo "release-env shell tests: OK"
