from __future__ import annotations

import re
import unittest

from app import app
from folder_visualizer import create_app


class FolderVisualizerRoutesTest(unittest.TestCase):
    def setUp(self) -> None:
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_all_html_pages_render(self) -> None:
        expected_markers = {
            "/": 'id="analyze-form"',
            "/summary": 'id="summary-root"',
            "/structure": 'id="structure-chart"',
            "/extensions": 'id="extension-chart"',
            "/age-distribution": 'id="age-chart"',
            "/large-files": 'id="large-files-body"',
            "/large-directories": 'id="large-directories-body"',
            "/cleanup": 'id="cleanup-controls"',
            "/duplicates": 'id="duplicate-controls"',
            "/history": 'id="history-content"',
            "/saved-searches": 'id="saved-search-form"',
            "/health-score": 'id="health-score-value"',
            "/project-analysis": 'id="project-results"',
            "/gitignore": 'id="gitignore-preview"',
            "/export": 'id="structure-export-form"',
            "/compare": 'id="folder-compare-form"',
            "/settings": 'id="settings-form"',
            "/privacy": 'id="privacy-title"',
            "/folder-visualization": 'id="folder-visualization-title"',
            "/folder-size-visualizer": 'id="folder-size-visualizer-title"',
            "/find-large-files": 'id="find-large-files-title"',
            "/folder-structure-visualizer": 'id="folder-structure-visualizer-title"',
        }

        for path, marker in expected_markers.items():
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.mimetype.startswith("text/html"))
                self.assertIn(marker, response.get_data(as_text=True))

    def test_health_endpoint(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {"status": "ok", "version": "1.1.0"},
        )
        self.assertIn("no-store", response.headers["Cache-Control"])

    def test_plotly_is_not_loaded_by_non_graph_pages(self) -> None:
        for path in ("/", "/summary", "/large-files", "/large-directories"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertNotIn(
                    'src="/assets/1.1.0/vendor/plotly.min.js"',
                    html,
                )

    def test_plotly_is_loaded_only_by_graph_pages(self) -> None:
        for path in ("/structure", "/extensions"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn(
                    'src="/assets/1.1.0/vendor/plotly.min.js"',
                    html,
                )

    def test_main_page_contains_only_the_dashboard_chart_not_detail_graphs(self) -> None:
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn('id="main-category-chart"', html)
        self.assertNotIn('id="structure-chart"', html)
        self.assertNotIn('id="extension-chart"', html)
        self.assertNotIn('id="large-files-body"', html)
        self.assertNotIn('id="large-directories-body"', html)
        self.assertIn('id="virtual-table-viewport"', html)

    def test_plotly_compatibility_route_requires_revalidation(self) -> None:
        response = self.client.get("/plotly.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response.mimetype)
        self.assertTrue(response.cache_control.no_cache)
        self.assertEqual(response.cache_control.max_age, 0)
        self.assertFalse(response.cache_control.immutable)
        self.assertGreater(len(response.data), 1_000_000)

    def test_no_analysis_upload_api_exists(self) -> None:
        allowed_rules = {
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
            "/folder-visualization",
            "/folder-size-visualizer",
            "/find-large-files",
            "/folder-structure-visualizer",
            "/sitemap.xml",
            "/robots.txt",
            "/health",
            "/assets/<version>/<path:filename>",
            "/plotly.js",
            "/static/<path:filename>",
        }
        rules = {rule.rule for rule in app.url_map.iter_rules()}
        self.assertEqual(rules, allowed_rules)

        for rule in app.url_map.iter_rules():
            self.assertFalse({"POST", "PUT", "PATCH", "DELETE"} & rule.methods)

    def test_security_headers_and_html_cache_policy(self) -> None:
        response = self.client.get("/")
        html = response.get_data(as_text=True)
        csp = response.headers["Content-Security-Policy"]
        nonce_match = re.search(r'<script[\s\S]*?\bnonce="([^"]+)"', html)
        self.assertIsNotNone(nonce_match)
        self.assertIn("default-src 'self'", csp)
        self.assertIn("'strict-dynamic'", csp)
        self.assertIn(f"'nonce-{nonce_match.group(1)}'", csp)
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
        self.assertIn("camera=()", response.headers["Permissions-Policy"])
        self.assertIn("no-store", response.headers["Cache-Control"])

    def test_adsense_loads_once_on_normal_pages_but_not_error_pages(self) -> None:
        script_url = (
            "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"
            "?client=ca-pub-4828937971968269"
        )
        for path in ("/", "/summary", "/settings", "/privacy"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertEqual(html.count(script_url), 1)

        not_found = self.client.get("/not-a-real-page").get_data(as_text=True)
        self.assertNotIn(script_url, not_found)

        test_app = create_app(
            {
                "TESTING": False,
                "PROPAGATE_EXCEPTIONS": False,
                "ENVIRONMENT_NAME": "testing",
            }
        )
        test_app.logger.disabled = True

        @test_app.get("/force-adsense-test-error")
        def force_adsense_test_error():
            raise RuntimeError("test")

        server_error = (
            test_app.test_client()
            .get("/force-adsense-test-error")
            .get_data(as_text=True)
        )
        self.assertNotIn(script_url, server_error)

    def test_adsense_can_be_disabled_by_configuration(self) -> None:
        test_app = create_app({"TESTING": True, "ADSENSE_CLIENT_ID": ""})
        html = test_app.test_client().get("/").get_data(as_text=True)
        self.assertNotIn("pagead2.googlesyndication.com", html)

    def test_hsts_is_sent_only_for_https(self) -> None:
        http_response = self.client.get("/")
        https_response = self.client.get("/", base_url="https://localhost")
        self.assertNotIn("Strict-Transport-Security", http_response.headers)
        self.assertIn(
            "max-age=31536000",
            https_response.headers["Strict-Transport-Security"],
        )

    def test_legacy_static_files_require_revalidation(self) -> None:
        response = self.client.get("/static/css/style.css")
        try:
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.cache_control.no_cache)
            self.assertEqual(response.cache_control.max_age, 0)
            self.assertFalse(response.cache_control.immutable)
        finally:
            response.close()

    def test_safe_404_page(self) -> None:
        response = self.client.get("/not-a-real-page?search=private-local-name")
        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 404)
        self.assertIn("ページが見つかりません", html)
        self.assertNotIn("private-local-name", html)

    def test_safe_500_page(self) -> None:
        test_app = create_app(
            {
                "TESTING": False,
                "PROPAGATE_EXCEPTIONS": False,
                "ENVIRONMENT_NAME": "testing",
            }
        )
        test_app.logger.disabled = True

        @test_app.get("/force-test-error")
        def force_test_error():
            raise RuntimeError("private internal detail")

        response = test_app.test_client().get("/force-test-error")
        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 500)
        self.assertIn("ページを表示できませんでした", html)
        self.assertNotIn("private internal detail", html)

    def test_production_configuration_disables_debug(self) -> None:
        production_app = create_app(
            {
                "ENVIRONMENT_NAME": "production",
                "DEBUG": True,
                "TESTING": True,
            }
        )
        self.assertFalse(production_app.debug)
        self.assertFalse(production_app.testing)
        self.assertTrue(production_app.config["SESSION_COOKIE_HTTPONLY"])


if __name__ == "__main__":
    unittest.main()
