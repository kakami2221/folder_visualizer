from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEPLOY = PROJECT_ROOT / "deploy"


class DeployReleaseEnvironmentContractTest(unittest.TestCase):
    def read_deploy(self, filename: str) -> str:
        return (DEPLOY / filename).read_text(encoding="utf-8")

    @unittest.skipUnless(shutil.which("bash"), "bash is required for shell tests")
    def test_release_environment_shell_tests(self) -> None:
        result = subprocess.run(
            [
                shutil.which("bash") or "bash",
                str(PROJECT_ROOT / "tests" / "shell" / "test_release_env.sh"),
            ],
            cwd=PROJECT_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("release-env shell tests: OK", result.stdout)

    def test_environment_helper_uses_safe_atomic_replacement(self) -> None:
        helper = self.read_deploy("release-env.sh")
        self.assertIn(
            "^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$",
            helper,
        )
        self.assertIn('! -f "${env_file}" || -L "${env_file}"', helper)
        self.assertIn(
            'mktemp "${env_dir}/.folder-visualizer.env.XXXXXX"',
            helper,
        )
        self.assertIn('chown --reference="${env_file}"', helper)
        self.assertIn('chmod --reference="${env_file}"', helper)
        self.assertIn('mv -fT -- "${temp_file}" "${env_file}"', helper)
        self.assertIn('EXPECTED_APP_VERSION="${expected_version}"', helper)
        self.assertIn('payload.get("version") ==', helper)

    def test_release_activation_restores_version_before_old_restart(self) -> None:
        helper = self.read_deploy("release-env.sh")
        activation = helper[helper.index("fv_activate_release() {"):]
        target_write = activation.index(
            'fv_write_app_version "${env_file}" "${target_version}"'
        )
        target_switch = activation.index(
            'ln -sfn "${target_release}" "${current_link}"'
        )
        target_health = activation.index(
            'fv_health_matches_version "${target_version}"'
        )
        old_write = activation.index(
            'fv_write_app_version "${env_file}" "${previous_version}"'
        )
        old_switch = activation.index(
            'ln -sfn "${previous_release}" "${current_link}"'
        )
        old_restart = activation.index(
            'systemctl restart "${service_name}"',
            old_switch,
        )
        old_health = activation.index(
            'fv_health_matches_version "${previous_version}"',
            old_restart,
        )
        self.assertLess(target_write, target_switch)
        self.assertLess(target_switch, target_health)
        self.assertLess(target_health, old_write)
        self.assertLess(old_write, old_switch)
        self.assertLess(old_switch, old_restart)
        self.assertLess(old_restart, old_health)
        self.assertNotRegex(helper, r"echo[^\n]*\$\{[^}]*version[^}]*\}")

    def test_install_aligns_version_before_switch_and_checks_health(self) -> None:
        install = self.read_deploy("install.sh")
        extract = install.index(
            'TARGET_APP_VERSION="$(fv_release_app_version "${RELEASE_DIR}")"'
        )
        write = install.index(
            'fv_write_app_version "${ENV_FILE}" "${TARGET_APP_VERSION}"'
        )
        switch = install.index(
            'ln -sfn "${RELEASE_DIR}" "${APP_ROOT}/current"'
        )
        health = install.index("fv_health_matches_version")
        self.assertLess(extract, write)
        self.assertLess(write, switch)
        self.assertLess(switch, health)

    def test_update_passes_both_release_versions_to_atomic_activation(self) -> None:
        update = self.read_deploy("update.sh")
        extract = update.index(
            'TARGET_APP_VERSION="$(fv_release_app_version "${RELEASE_DIR}")"'
        )
        activate = update.index("if ! fv_activate_release")
        activation_call = update[activate:update.index("exit 1", activate)]
        self.assertLess(extract, activate)
        for required in (
            '"${ENV_FILE}"',
            '"${APP_ROOT}/current"',
            '"${RELEASE_DIR}"',
            '"${TARGET_APP_VERSION}"',
            '"${PREVIOUS_TARGET}"',
            '"${PREVIOUS_RELEASE_VERSION}"',
        ):
            self.assertIn(required, activation_call)
        self.assertNotRegex(update, r"echo[^\n]*\$\{[^}]*VERSION")

    def test_rollback_passes_both_release_versions_to_atomic_activation(self) -> None:
        rollback = self.read_deploy("rollback.sh")
        extract = rollback.index(
            'TARGET_APP_VERSION="$(fv_release_app_version "${TARGET}")"'
        )
        activate = rollback.index("if ! fv_activate_release")
        activation_call = rollback[activate:rollback.index("exit 1", activate)]
        self.assertLess(extract, activate)
        for required in (
            '"${ENV_FILE}"',
            '"${APP_ROOT}/current"',
            '"${TARGET}"',
            '"${TARGET_APP_VERSION}"',
            '"${CURRENT_TARGET}"',
            '"${CURRENT_RELEASE_VERSION}"',
        ):
            self.assertIn(required, activation_call)
        self.assertNotRegex(rollback, r"echo[^\n]*\$\{[^}]*VERSION")

    def test_documentation_no_longer_requires_manual_version_switching(self) -> None:
        readme = (PROJECT_ROOT / "README.md").read_text(encoding="utf-8")
        ec2 = (DEPLOY / "README-EC2.md").read_text(encoding="utf-8")
        for document in (readme, ec2):
            with self.subTest(document="README" if document is readme else "EC2"):
                self.assertNotIn(
                    "sudoedit /etc/folder-visualizer/folder-visualizer.env\n"
                    "sudo SOURCE_DIR",
                    document,
                )
                self.assertNotIn("it does not restore the environment file", document)


if __name__ == "__main__":
    unittest.main()
