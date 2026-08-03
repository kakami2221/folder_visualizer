from __future__ import annotations

import re
import unittest
from pathlib import Path

from folder_visualizer import create_app


ROOT = Path(__file__).resolve().parents[1]
CLEANUP_JS = ROOT / "static" / "js" / "pages" / "cleanup.js"
HEALTH_JS = ROOT / "static" / "js" / "pages" / "health-score.js"


class CleanupPageContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cleanup_source = CLEANUP_JS.read_text(encoding="utf-8")
        cls.health_source = HEALTH_JS.read_text(encoding="utf-8")
        app = create_app("testing")
        with app.test_client() as client:
            response = client.get("/cleanup")
        cls.cleanup_html = response.get_data(as_text=True)
        cls.cleanup_status = response.status_code

    def test_required_cleanup_categories_are_visible(self) -> None:
        self.assertEqual(self.cleanup_status, 200)
        expected_options = {
            "same-name": "同名ファイル候補",
            "very-large": "非常に大きい単一ファイル",
            "concentrated-directory": "ファイルが集中しているフォルダ",
        }
        for value, label in expected_options.items():
            with self.subTest(value=value):
                self.assertRegex(
                    self.cleanup_html,
                    rf'<option\s+value="{re.escape(value)}">{re.escape(label)}</option>',
                )
                self.assertIn(f'"{value}": "{label}"', self.cleanup_source)

    def test_empty_directory_limit_and_metadata_only_rule_are_explicit(self) -> None:
        self.assertIn("空フォルダ", self.cleanup_html)
        self.assertIn("webkitdirectory", self.cleanup_html)
        self.assertIn("整理候補には表示されません", self.cleanup_html)
        self.assertIn("同名・同サイズのメタデータ", self.cleanup_html)
        self.assertIn("未確認の候補", self.cleanup_html)
        self.assertIn("保存済みメタデータと集計だけ", self.cleanup_html)
        self.assertIn("ファイル内容は読みません", self.cleanup_html)

    def test_cleanup_uses_existing_aggregate_stores(self) -> None:
        self.assertIn(
            'Storage.getDuplicateCandidates("same-name-size")',
            self.cleanup_source,
        )
        self.assertIn("Storage.getDirectories()", self.cleanup_source)
        self.assertIn("createCandidateContext(", self.cleanup_source)
        self.assertIn("candidate.groupKey", self.cleanup_source)
        self.assertIn("candidate.members", self.cleanup_source)

    def test_same_name_candidates_cover_members_and_truncated_group_keys(self) -> None:
        self.assertIn("duplicateFileIds.add(String(member.id))", self.cleanup_source)
        self.assertIn("duplicateGroupKeys.add(groupKey)", self.cleanup_source)
        self.assertIn(
            "duplicateGroupKeys.add(sameNameSizeKey(member))",
            self.cleanup_source,
        )
        self.assertIn(
            "context?.duplicateGroupKeys?.has(sameNameSizeKey(file))",
            self.cleanup_source,
        )
        self.assertIn('types.push("same-name")', self.cleanup_source)

    def test_concentrated_directory_rule_matches_health_score_rule(self) -> None:
        direct_count = r"(?:Number\(directory\.)?directFileCount\)?"
        for name, source in (
            ("cleanup", self.cleanup_source),
            ("health", self.health_source),
        ):
            with self.subTest(source=name):
                self.assertRegex(source, rf"{direct_count}\s*>=\s*1000")
                self.assertRegex(source, r"totalFiles\s*>=\s*100")
                self.assertRegex(
                    source,
                    rf"{direct_count}\s*/\s*totalFiles\s*>=\s*0\.25",
                )
        self.assertIn("path !== rootName", self.cleanup_source)
        self.assertIn(
            'context?.concentratedDirectoryPaths?.has(String(file.parentPath || ""))',
            self.cleanup_source,
        )
        self.assertIn('types.push("concentrated-directory")', self.cleanup_source)

    def test_one_file_remains_one_candidate_and_one_capacity_entry(self) -> None:
        self.assertIn("selected: new Map()", self.cleanup_source)
        self.assertIn(
            "state.selected.set(String(item.id), item)",
            self.cleanup_source,
        )
        self.assertEqual(
            self.cleanup_source.count("candidates.push(slimCandidate(file, types))"),
            1,
        )
        update_simulation = self.cleanup_source.split(
            "function updateSimulation()", 1,
        )[1].split("function applyCategoryFilter()", 1)[0]
        self.assertEqual(update_simulation.count("selectedSize += item.size"), 1)
        self.assertNotIn("item.types.forEach", update_simulation)

    def test_cleanup_never_reads_file_content(self) -> None:
        for forbidden in (
            "FileReader",
            ".arrayBuffer(",
            ".text(",
            ".stream(",
            ".readAsArrayBuffer(",
            ".readAsText(",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.cleanup_source)


if __name__ == "__main__":
    unittest.main()
