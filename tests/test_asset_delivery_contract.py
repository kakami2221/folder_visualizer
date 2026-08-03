from __future__ import annotations

import unittest
from urllib.parse import urljoin

from folder_visualizer import create_app
from folder_visualizer.routes.assets import asset_url


class VersionedAssetDeliveryContractTest(unittest.TestCase):
    def make_app(self, environment: str, version: str = "1.1.0"):
        return create_app(
            {
                "APP_VERSION": version,
                "ENVIRONMENT_NAME": environment,
                "TESTING": environment == "testing",
            }
        )

    def test_helper_and_route_use_the_exact_application_version(self) -> None:
        first = self.make_app("testing", "release-a")
        second = self.make_app("testing", "release-b")

        with first.test_request_context():
            first_url = asset_url("css/style.css")
        with second.test_request_context():
            second_url = asset_url("css/style.css")

        self.assertEqual(first_url, "/assets/release-a/css/style.css")
        self.assertEqual(second_url, "/assets/release-b/css/style.css")
        self.assertEqual(
            first.test_client().get(first_url, buffered=True).status_code,
            200,
        )
        self.assertEqual(first.test_client().get(second_url).status_code, 404)

    def test_invalid_application_versions_fail_during_startup(self) -> None:
        for version in ("", "1/2", r"1\2", "../release", " release", "v?query"):
            with self.subTest(version=version):
                with self.assertRaisesRegex(RuntimeError, "APP_VERSION"):
                    self.make_app("testing", version)

        valid = self.make_app("testing", "1.1.0+build.4")
        with valid.test_request_context():
            self.assertEqual(
                asset_url("css/style.css"),
                "/assets/1.1.0+build.4/css/style.css",
            )

    def test_asset_helper_rejects_unsafe_paths(self) -> None:
        app = self.make_app("testing")
        with app.test_request_context():
            for filename in ("", "/css/style.css", "../style.css", r"..\style.css"):
                with self.subTest(filename=filename):
                    with self.assertRaises(ValueError):
                        asset_url(filename)

    def test_route_rejects_wrong_versions_and_traversal(self) -> None:
        app = self.make_app("testing", "current")
        client = app.test_client()
        for path in (
            "/assets/old/css/style.css",
            "/assets/current/%2e%2e/config.py",
            "/assets/current/..%5Cconfig.py",
        ):
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 404)
                self.assertTrue(response.cache_control.no_store)

    def test_versioned_static_and_plotly_assets_are_served(self) -> None:
        app = self.make_app("testing")
        client = app.test_client()

        css = client.get("/assets/1.1.0/css/style.css", buffered=True)
        module = client.get("/assets/1.1.0/js/pages/index.js", buffered=True)
        plotly = client.get("/assets/1.1.0/vendor/plotly.min.js")

        self.assertEqual(css.status_code, 200)
        self.assertEqual(css.mimetype, "text/css")
        self.assertEqual(module.status_code, 200)
        self.assertIn("javascript", module.mimetype)
        self.assertEqual(plotly.status_code, 200)
        self.assertIn("javascript", plotly.mimetype)
        self.assertGreater(len(plotly.data), 1_000_000)

    def test_relative_module_and_worker_urls_keep_the_version_prefix(self) -> None:
        app = self.make_app("testing", "module-release")
        client = app.test_client()
        page_url = "/assets/module-release/js/pages/index.js"
        analyzer_url = urljoin(page_url, "../analysis/analyzer.js")
        worker_url = urljoin(analyzer_url, "./analysis-worker.js")

        self.assertEqual(
            analyzer_url,
            "/assets/module-release/js/analysis/analyzer.js",
        )
        self.assertEqual(
            worker_url,
            "/assets/module-release/js/analysis/analysis-worker.js",
        )
        page_source = client.get(page_url, buffered=True).get_data(as_text=True)
        analyzer_source = client.get(
            analyzer_url,
            buffered=True,
        ).get_data(as_text=True)
        self.assertIn('from "../analysis/analyzer.js"', page_source)
        self.assertIn(
            'new URL("./analysis-worker.js", import.meta.url)',
            analyzer_source,
        )
        self.assertEqual(client.get(worker_url, buffered=True).status_code, 200)

    def test_production_versioned_assets_are_immutable_for_one_year(self) -> None:
        app = self.make_app("production", "production-release")
        client = app.test_client()
        response = client.get(
            "/assets/production-release/css/style.css",
            buffered=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.cache_control.public)
        self.assertEqual(response.cache_control.max_age, 31_536_000)
        self.assertTrue(response.cache_control.immutable)
        self.assertFalse(response.cache_control.no_cache)

    def test_development_and_testing_versioned_assets_require_revalidation(self) -> None:
        for environment in ("development", "testing"):
            app = self.make_app(environment, environment)
            response = app.test_client().get(
                f"/assets/{environment}/css/style.css",
                buffered=True,
            )
            with self.subTest(environment=environment):
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.cache_control.no_cache)
                self.assertEqual(response.cache_control.max_age, 0)
                self.assertFalse(response.cache_control.immutable)

    def test_legacy_asset_urls_are_never_immutable(self) -> None:
        app = self.make_app("production")
        client = app.test_client()
        for path in ("/static/css/style.css", "/plotly.js"):
            response = client.get(path, buffered=True)
            with self.subTest(path=path):
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.cache_control.no_cache)
                self.assertEqual(response.cache_control.max_age, 0)
                self.assertFalse(response.cache_control.immutable)

    def test_head_and_conditional_requests_keep_production_cache_policy(self) -> None:
        app = self.make_app("production", "conditional-release")
        client = app.test_client()
        path = "/assets/conditional-release/css/style.css"
        initial = client.get(path, buffered=True)
        etag = initial.headers.get("ETag")
        self.assertIsNotNone(etag)

        head = client.head(path, buffered=True)
        not_modified = client.get(
            path,
            headers={"If-None-Match": etag},
            buffered=True,
        )
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.data, b"")
        self.assertEqual(not_modified.status_code, 304)
        self.assertTrue(head.cache_control.immutable)
        self.assertTrue(not_modified.cache_control.immutable)

    def test_asset_route_is_read_only(self) -> None:
        app = self.make_app("testing")
        client = app.test_client()
        path = "/assets/1.1.0/css/style.css"
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assertEqual(getattr(client, method)(path).status_code, 405)


if __name__ == "__main__":
    unittest.main()
