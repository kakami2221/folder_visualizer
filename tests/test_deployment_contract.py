from __future__ import annotations

import re
import unittest
from pathlib import Path

from folder_visualizer import create_app
from folder_visualizer.routes.pages import PAGE_ROUTES


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class DeploymentContractTest(unittest.TestCase):
    def test_application_factory_creates_isolated_apps(self) -> None:
        first = create_app("testing")
        second = create_app("testing")
        self.assertIsNot(first, second)
        self.assertTrue(first.testing)
        self.assertEqual(first.config["APP_VERSION"], "1.1.0")

    def test_all_required_page_routes_are_registered(self) -> None:
        required_paths = {
            "/",
            "/summary",
            "/structure",
            "/extensions",
            "/age-distribution",
            "/large-files",
            "/large-directories",
            "/cleanup",
            "/duplicates",
            "/history",
            "/saved-searches",
            "/health-score",
            "/project-analysis",
            "/gitignore",
            "/export",
            "/compare",
            "/settings",
            "/privacy",
        }
        self.assertEqual({path for path, _endpoint, _template in PAGE_ROUTES}, required_paths)

    def test_production_defaults_are_secure(self) -> None:
        production_app = create_app("production")
        self.assertFalse(production_app.debug)
        self.assertFalse(production_app.testing)
        self.assertTrue(production_app.config["SESSION_COOKIE_SECURE"])
        self.assertTrue(production_app.config["SESSION_COOKIE_HTTPONLY"])
        self.assertIn(
            production_app.config["SESSION_COOKIE_SAMESITE"],
            {"Lax", "Strict", "None"},
        )

    def test_dependencies_are_fixed(self) -> None:
        requirements = (PROJECT_ROOT / "requirements.txt").read_text(encoding="utf-8")
        package_lines = [
            line.strip()
            for line in requirements.splitlines()
            if line.strip() and not line.startswith("#")
        ]
        self.assertTrue(package_lines)
        for line in package_lines:
            with self.subTest(requirement=line):
                self.assertRegex(line, r"^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$")

    def test_required_production_files_exist(self) -> None:
        required = (
            ".env.example",
            "Dockerfile",
            "docker-compose.yml",
            "gunicorn.conf.py",
            "nginx/default.conf",
            "deploy/install.sh",
            "deploy/update.sh",
            "deploy/backup.sh",
            "deploy/rollback.sh",
            "deploy/release-env.sh",
            "deploy/certbot-reload-nginx.sh",
            "deploy/folder-visualizer.service",
            "deploy/folder-visualizer.logrotate",
            "deploy/README-EC2.md",
        )
        for relative_path in required:
            with self.subTest(path=relative_path):
                self.assertTrue((PROJECT_ROOT / relative_path).is_file())

    def test_access_log_formats_omit_query_strings(self) -> None:
        gunicorn = (PROJECT_ROOT / "gunicorn.conf.py").read_text(encoding="utf-8")
        nginx = (PROJECT_ROOT / "nginx/default.conf").read_text(encoding="utf-8")

        format_match = re.search(
            r"access_log_format\s*=\s*\((.*?)\)\n\n",
            gunicorn,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(format_match)
        self.assertNotIn("%(U)s", format_match.group(1))
        self.assertNotIn("%(q)s", format_match.group(1))
        self.assertNotIn("%(r)s", format_match.group(1))

        log_format = nginx.split("server {", 1)[0]
        self.assertIn("$request_method $server_protocol", log_format)
        self.assertNotIn("$uri", log_format)
        self.assertNotIn("$request_uri", log_format)
        self.assertNotIn("$http_referer", log_format)
        self.assertNotIn("$http_user_agent", log_format)

    def test_deployment_keeps_gunicorn_on_loopback(self) -> None:
        env_example = (PROJECT_ROOT / ".env.example").read_text(encoding="utf-8")
        compose = (PROJECT_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        nginx = (PROJECT_ROOT / "nginx/default.conf").read_text(encoding="utf-8")
        self.assertIn("GUNICORN_BIND=127.0.0.1:8000", env_example)
        self.assertIn('"127.0.0.1:8000:8000"', compose)
        self.assertIn("proxy_pass http://127.0.0.1:8000", nginx)

    def test_release_version_defaults_are_consistent(self) -> None:
        env_example = (PROJECT_ROOT / ".env.example").read_text(encoding="utf-8")
        dockerfile = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")
        compose = (PROJECT_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("APP_VERSION=1.1.0", env_example)
        self.assertIn("APP_VERSION=1.1.0", dockerfile)
        self.assertIn('${APP_VERSION:-1.1.0}', compose)

    def test_nginx_preserves_versioned_asset_validation(self) -> None:
        for relative_path in ("nginx/default.conf", "nginx/bootstrap.conf"):
            config = (PROJECT_ROOT / relative_path).read_text(encoding="utf-8")
            with self.subTest(path=relative_path):
                assets_location = config.split("location ^~ /assets/", 1)[1]
                self.assertIn("proxy_pass http://127.0.0.1:8000", assets_location)
                self.assertNotIn("alias ", assets_location.split("location ", 1)[0])
                self.assertNotIn("rewrite ", assets_location.split("location ", 1)[0])

                legacy_static = config.split("location /static/", 1)[1]
                legacy_static = legacy_static.split("location ", 1)[0]
                self.assertIn("expires -1", legacy_static)
                self.assertNotIn("expires 1y", legacy_static)


if __name__ == "__main__":
    unittest.main()
