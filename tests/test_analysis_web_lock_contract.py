from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ANALYZER = ROOT / "static" / "js" / "analysis" / "analyzer.js"


class AnalysisWebLockContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = ANALYZER.read_text(encoding="utf-8")

    def test_origin_wide_exclusive_lock_is_requested_without_waiting(self) -> None:
        self.assertIn(
            'ANALYSIS_LOCK_NAME = "folder-visualizer-analysis"',
            self.source,
        )
        analyze = re.search(
            r"export async function analyze\(.*?(?=\nasync function runAnalysis)",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(analyze)
        source = analyze.group()
        self.assertIn("locks.request(", source)
        self.assertIn("ANALYSIS_LOCK_NAME", source)
        self.assertRegex(
            source,
            r"\{\s*mode:\s*\"exclusive\",\s*ifAvailable:\s*true\s*\}",
        )

    def test_contention_returns_a_japanese_error_before_worker_start(self) -> None:
        unavailable = re.search(
            r"function createLockUnavailableError\(\)\s*\{(?P<body>.*?)\n\}",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(unavailable)
        self.assertIn("別のタブで解析中です", unavailable.group("body"))
        self.assertIn("analysis-lock-unavailable", unavailable.group("body"))
        self.assertRegex(
            self.source,
            r"if \(!lock\) \{\s*throw createLockUnavailableError\(\);",
        )

    def test_lock_covers_the_complete_analysis_promise_and_is_released(self) -> None:
        self.assertIn("return runAnalysis(fileList, options);", self.source)
        self.assertRegex(
            self.source,
            r"try \{\s*return await lockRequest;\s*\} finally \{\s*"
            r"if \(activeLockRequest === lockRequest\) \{\s*"
            r"activeLockRequest = null;",
        )

    def test_same_tab_cancel_and_unsupported_browser_fallback_are_preserved(self) -> None:
        analyze = re.search(
            r"export async function analyze\(.*?(?=\nasync function runAnalysis)",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(analyze)
        source = analyze.group()
        cancel_position = source.index("await cancel();")
        wait_position = source.index("await waitForLocalLockRelease();")
        self.assertLess(cancel_position, wait_position)
        self.assertRegex(
            source,
            r'if \(!locks \|\| typeof locks\.request !== "function"\) \{\s*'
            r"return runAnalysis\(fileList, options\);",
        )


if __name__ == "__main__":
    unittest.main()
