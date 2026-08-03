from __future__ import annotations

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "templates" / "structure.html"
MODULE = ROOT / "static" / "js" / "pages" / "structure.js"


class StructureOptionsContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.template = TEMPLATE.read_text(encoding="utf-8")
        cls.module = MODULE.read_text(encoding="utf-8")

    def test_file_and_other_controls_are_rendered_with_safe_defaults(self) -> None:
        self.assertRegex(
            self.template,
            r'id="structure-include-files"\s+type="checkbox"',
        )
        self.assertNotRegex(
            self.template,
            r'id="structure-include-files"[^>]*\bchecked\b',
        )
        self.assertRegex(
            self.template,
            r'id="structure-aggregate-others"\s+type="checkbox"\s+checked',
        )

    def test_settings_and_cache_key_include_both_options(self) -> None:
        for control_id in (
            "structure-include-files",
            "structure-aggregate-others",
        ):
            with self.subTest(control=control_id):
                self.assertIn(
                    f'document.getElementById("{control_id}")?.checked',
                    self.module,
                )
        self.assertIn('settings.includeFiles ? "files" : "folders"', self.module)
        self.assertIn(
            'settings.aggregateOthers ? "aggregate" : "omit"',
            self.module,
        )

    def test_file_candidates_are_bounded_and_loaded_in_chunks(self) -> None:
        self.assertIn("const FILE_READ_CHUNK_SIZE = 1000", self.module)
        self.assertIn("Storage.queryFileIds({", self.module)
        self.assertIn("directory: current.path", self.module)
        self.assertIn("minSize: settings.minSize", self.module)
        self.assertIn("maxDepth: current.depth + settings.maxDepth", self.module)
        self.assertIn('sortBy: "size"', self.module)
        self.assertIn('direction: "desc"', self.module)
        self.assertIn("limit,", self.module)
        self.assertIn("Storage.getFilesByIds(", self.module)
        self.assertIn(
            "result.ids.slice(start, start + FILE_READ_CHUNK_SIZE)",
            self.module,
        )
        self.assertNotIn("Storage.getAllRecords(\"files\")", self.module)
        self.assertNotIn("Storage.getAllFiles", self.module)

    def test_other_nodes_are_created_only_when_enabled(self) -> None:
        self.assertRegex(
            self.module,
            r"if \(settings\.aggregateOthers\) selectedDirectories\.forEach",
        )
        self.assertIn('labels.push("その他")', self.module)
        self.assertIn('settings.aggregateOthers ? "aggregate" : "omit"', self.module)

    def test_chart_never_exceeds_node_budget_and_files_have_navigation_data(self) -> None:
        self.assertIn("export function calculateStructureNodeBudget(", self.module)
        self.assertIn("maximumNodes - 1 - otherReserve", self.module)
        self.assertIn("budget.selectedDirectories", self.module)
        self.assertIn("budget.selectedFiles", self.module)
        self.assertIn(
            "Math.max(files.length, Number(eligibleFileCount) || 0)",
            self.module,
        )
        self.assertIn('"file"', self.module)
        self.assertIn("file.relativePath", self.module)
        self.assertIn("buildMainUrl({ path: relativePath })", self.module)

    def test_sunburst_remains_user_triggered_and_cached_data_is_shared(self) -> None:
        initialize_match = re.search(
            r"export async function initializeStructurePage\(\)"
            r"[\s\S]*?initializeWhenReady\(initializeStructurePage\);",
            self.module,
        )
        self.assertIsNotNone(initialize_match)
        initialize_source = initialize_match.group(0)
        self.assertIn('await drawStructure("treemap")', initialize_source)
        self.assertNotIn('await drawStructure("sunburst")', initialize_source)
        self.assertRegex(
            self.module,
            r'getElementById\("sunburst-button"\).*?addEventListener\("click"'
            r'[\s\S]*?drawStructure\("sunburst"\)',
        )
        self.assertNotIn("mode,\n    settings.maxDepth", self.module)
        self.assertIn("readCachedChartData(settings)", self.module)

    def test_structure_page_never_reads_file_contents(self) -> None:
        for forbidden in (
            "FileReader",
            ".arrayBuffer(",
            ".text(",
            ".stream(",
            "readAsArrayBuffer",
            "readAsText",
        ):
            with self.subTest(token=forbidden):
                self.assertNotIn(forbidden, self.module)


if __name__ == "__main__":
    unittest.main()
