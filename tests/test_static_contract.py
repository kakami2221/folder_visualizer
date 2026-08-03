from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
STATIC_JS = ROOT / "static" / "js"
TEMPLATES = ROOT / "templates"


class StaticArchitectureContractTest(unittest.TestCase):
    def test_expected_javascript_modules_exist(self) -> None:
        expected = {
            "common.js",
            "storage.js",
            "analyzer.js",
            "analysis-worker.js",
            "virtual-table.js",
            "index.js",
            "structure.js",
            "extensions.js",
            "large-files.js",
            "large-directories.js",
            "summary.js",
        }
        self.assertTrue(expected.issubset({path.name for path in STATIC_JS.glob("*.js")}))
        self.assertFalse((STATIC_JS / "main.js").exists())
        for relative_path in (
            "common/constants.js",
            "storage/index.js",
            "storage/database.js",
            "storage/repositories.js",
            "storage/migrations.js",
            "storage/cache.js",
            "analysis/analyzer.js",
            "analysis/analysis-worker.js",
            "analysis/duplicate-worker.js",
            "analysis/compare-worker.js",
            "analysis/project-detector.js",
        ):
            with self.subTest(relative_path=relative_path):
                self.assertTrue((STATIC_JS / relative_path).is_file())

    def test_no_file_content_or_upload_apis_are_used(self) -> None:
        sources = {
            path.relative_to(STATIC_JS).as_posix(): path.read_text(encoding="utf-8")
            for path in STATIC_JS.rglob("*.js")
        }
        network_and_write_tokens = (
            "XMLHttpRequest",
            "sendBeacon(",
            "WebSocket(",
            "fetch(",
            "showDirectoryPicker",
            "localStorage",
            "sessionStorage",
        )
        for relative_path, source in sources.items():
            for token in network_and_write_tokens:
                with self.subTest(relative_path=relative_path, token=token):
                    self.assertNotIn(token, source)

        content_read_tokens = ("FileReader", ".readAsArrayBuffer(", ".readAsText(", ".arrayBuffer(")
        for relative_path, source in sources.items():
            if relative_path == "analysis/duplicate-worker.js":
                continue
            for token in content_read_tokens:
                with self.subTest(relative_path=relative_path, token=token):
                    self.assertNotIn(token, source)

    def test_indexeddb_schema_contains_required_stores_and_indexes(self) -> None:
        source = (STATIC_JS / "storage" / "migrations.js").read_text(encoding="utf-8")
        for store in (
            "analysisMeta",
            "files",
            "directories",
            "extensions",
            "ageBuckets",
            "largestFiles",
            "largestDirectories",
            "duplicateCandidates",
            "duplicateHashes",
            "analysisHistory",
            "historyFiles",
            "savedSearches",
            "cleanupRules",
            "appSettings",
            "projectDetection",
            "comparisonResults",
        ):
            with self.subTest(store=store):
                self.assertIn(f'"{store}"', source)

        for index in (
            "nameLower",
            "relativePathLower",
            "pathLower",
            "extension",
            "category",
            "size",
            "lastModified",
            "parentPath",
            "depth",
            "analysisId",
        ):
            with self.subTest(index=index):
                self.assertIn(f'"{index}"', source)

    def test_worker_and_virtualization_limits_are_present(self) -> None:
        analyzer = (STATIC_JS / "analysis" / "analyzer.js").read_text(encoding="utf-8")
        worker = (STATIC_JS / "analysis-worker.js").read_text(encoding="utf-8")
        virtual = (STATIC_JS / "virtual-table.js").read_text(encoding="utf-8")

        constants = (STATIC_JS / "common" / "constants.js").read_text(encoding="utf-8")
        self.assertIn("chunkSize: 2000", constants)
        self.assertIn("export const CHUNK_SIZE", analyzer)
        self.assertIn("new Worker", analyzer)
        self.assertIn("BoundedMinHeap", worker)
        self.assertIn("new Map()", worker)
        self.assertIn("MAX_DOM_ROWS", virtual)
        self.assertIn("CHUNK_SIZE", virtual)
        self.assertIn("ResizeObserver", virtual)
        self.assertIn("requestAnimationFrame", virtual)

    def test_plotly_is_referenced_only_by_graph_pages(self) -> None:
        graph_pages = {
            "index.html",
            "structure.html",
            "extensions.html",
            "age_distribution.html",
            "history.html",
            "health_score.html",
            "compare.html",
        }
        for template in TEMPLATES.glob("*.html"):
            text = template.read_text(encoding="utf-8")
            with self.subTest(template=template.name):
                if template.name in graph_pages:
                    self.assertIn("asset_url('vendor/plotly.min.js')", text)
                    self.assertNotIn("plotly_bundle", text)
                else:
                    self.assertNotIn("vendor/plotly.min.js", text)
                    self.assertNotIn("plotly_bundle", text)


if __name__ == "__main__":
    unittest.main()
