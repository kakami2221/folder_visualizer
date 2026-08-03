from __future__ import annotations

import re
import unittest
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "static" / "js" / "analysis-worker.js"


@dataclass(frozen=True, slots=True)
class CompactFile:
    identifier: int
    name: str
    relative_path: str
    size: int
    last_modified: int
    extension: str


class DuplicateWorkerMemoryContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = WORKER.read_text(encoding="utf-8")

    def test_compact_metadata_is_created_once_and_shared_by_all_modes(self) -> None:
        process_chunk = re.search(
            r"function processChunk\(.*?(?=\nfunction chooseExtension)",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(process_chunk)
        source = process_chunk.group()
        self.assertEqual(source.count("createDuplicateMetadata(file)"), 1)
        self.assertIn("map.observe(file, duplicateMetadata)", source)
        self.assertIn("observe(file, compact)", self.source)

        observe = re.search(
            r"observe\(file, compact\)\s*\{(?P<body>.*?)\n\s*\}\n\n\s*finalize",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(observe)
        self.assertNotIn("const compact = {", observe.group("body"))

    def test_singletons_use_the_compact_record_without_group_wrapper(self) -> None:
        self.assertIn("this.groups.set(key, compact);", self.source)
        self.assertNotIn("first: compact", self.source)
        self.assertRegex(
            self.source,
            r"if \(!Array\.isArray\(current\.members\)\) \{\s*"
            r"this\.groups\.set\(key, \{\s*"
            r"members: \[current, compact\],\s*"
            r"fileCount: 2,",
        )

    def test_finalize_keeps_exact_bounded_top_candidates(self) -> None:
        finalize = re.search(
            r"finalize\(analysisId\)\s*\{(?P<body>.*?)\n\s*\}\n\}",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(finalize)
        source = finalize.group("body")
        self.assertIn("new BoundedMinHeap(", source)
        self.assertIn("MAX_DUPLICATE_GROUPS", source)
        self.assertIn("compareDuplicateCandidatePriority", source)
        self.assertIn("return candidates.toSortedDescending();", source)
        self.assertNotIn(".sort(", source)
        self.assertNotIn(".slice(", source)

    def test_one_hundred_thousand_unique_files_share_one_compact_each(self) -> None:
        file_count = 100_000
        modes = ({}, {}, {})
        compact_records = []
        for identifier in range(file_count):
            compact = CompactFile(
                identifier=identifier,
                name=f"file-{identifier}.dat",
                relative_path=f"root/file-{identifier}.dat",
                size=identifier + 1,
                last_modified=identifier,
                extension=".dat",
            )
            compact_records.append(compact)
            keys = (
                str(compact.size),
                f"{compact.name}\0{compact.size}",
                f"{compact.name}\0{compact.size}\0{compact.last_modified}",
            )
            for groups, key in zip(modes, keys, strict=True):
                groups[key] = compact

        self.assertEqual(len(compact_records), file_count)
        self.assertTrue(all(len(groups) == file_count for groups in modes))
        for identifier in (0, file_count // 2, file_count - 1):
            compact = compact_records[identifier]
            self.assertIs(modes[0][str(compact.size)], compact)
            self.assertIs(
                modes[1][f"{compact.name}\0{compact.size}"],
                compact,
            )
            self.assertIs(
                modes[2][
                    f"{compact.name}\0{compact.size}\0{compact.last_modified}"
                ],
                compact,
            )


if __name__ == "__main__":
    unittest.main()
