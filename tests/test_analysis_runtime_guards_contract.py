from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AnalysisRuntimeGuardsContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database = (
            ROOT / "static" / "js" / "storage" / "database.js"
        ).read_text(encoding="utf-8")
        cls.analyzer = (
            ROOT / "static" / "js" / "analysis" / "analyzer.js"
        ).read_text(encoding="utf-8")
        cls.repositories = (
            ROOT / "static" / "js" / "storage" / "repositories.js"
        ).read_text(encoding="utf-8")

    def test_blocked_database_open_times_out_and_late_connection_is_closed(self) -> None:
        self.assertIn("BLOCKED_OPEN_TIMEOUT_MS = 8_000", self.database)
        blocked_handler = re.search(
            r"request\.onblocked\s*=\s*\(\)\s*=>\s*\{(?P<body>.*?)\n\s*\};",
            self.database,
            re.DOTALL,
        )
        self.assertIsNotNone(blocked_handler)
        body = blocked_handler.group("body")
        self.assertIn("globalThis.setTimeout", body)
        self.assertIn("database-blocked", body)
        self.assertIn("他のタブを閉じて", body)

        success_handler = re.search(
            r"request\.onsuccess\s*=\s*\(\)\s*=>\s*\{(?P<body>.*?)\n\s*\};",
            self.database,
            re.DOTALL,
        )
        self.assertIsNotNone(success_handler)
        self.assertRegex(
            success_handler.group("body"),
            r"if\s*\(settled\)\s*\{\s*database\.close\(\);\s*return;",
        )
        self.assertRegex(
            self.database,
            r"\}\)\.catch\(\(error\)\s*=>\s*\{\s*databasePromise\s*=\s*null;",
        )

    def test_begin_analysis_propagates_database_open_failure(self) -> None:
        begin_analysis = re.search(
            r"export async function beginAnalysis\(.*?(?=\nexport async function)",
            self.repositories,
            re.DOTALL,
        )
        self.assertIsNotNone(begin_analysis)
        source = begin_analysis.group()
        self.assertIn("const database = await openDatabase();", source)
        self.assertNotRegex(source, r"catch\s*\([^)]*\)\s*\{")

    def test_history_completion_rechecks_active_run_before_session_files(self) -> None:
        history_end = self.analyzer.index(
            'console.warn("解析は完了しましたが、履歴を保存できませんでした。", error);'
        )
        guard = self.analyzer.index("assertRunActive(run);", history_end)
        session_assignment = self.analyzer.index("sessionFileList = fileList;", history_end)
        self.assertLess(guard, session_assignment)


if __name__ == "__main__":
    unittest.main()
