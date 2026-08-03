from __future__ import annotations

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
STATIC_JS = ROOT / "static" / "js"
TEMPLATES = ROOT / "templates"
SECURITY_HEADERS = ROOT / "folder_visualizer" / "security" / "headers.py"
NGINX_CONFIG = ROOT / "nginx" / "default.conf"


def javascript_sources() -> dict[str, str]:
    return {
        path.relative_to(STATIC_JS).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(STATIC_JS.rglob("*.js"))
    }


class ClientSecurityBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sources = javascript_sources()

    def assert_no_pattern(
        self,
        patterns: dict[str, str],
        *,
        sources: dict[str, str] | None = None,
    ) -> None:
        checked = sources or self.sources
        for relative_path, source in checked.items():
            for label, pattern in patterns.items():
                with self.subTest(file=relative_path, pattern=label):
                    self.assertIsNone(
                        re.search(pattern, source, flags=re.IGNORECASE),
                        f"{relative_path} contains forbidden {label}",
                    )

    def test_no_client_network_or_upload_api(self) -> None:
        self.assert_no_pattern({
            "fetch": r"\bfetch\s*\(",
            "XMLHttpRequest": r"\bXMLHttpRequest\b",
            "WebSocket": r"\bWebSocket\s*\(",
            "EventSource": r"\bEventSource\s*\(",
            "sendBeacon": r"\bsendBeacon\s*\(",
            "WebTransport": r"\bWebTransport\b",
            "RTCPeerConnection": r"\bRTCPeerConnection\b",
            "remote URL literal": r"""["'`]https?://""",
        })

    def test_no_file_system_write_delete_or_readwrite_permission_api(self) -> None:
        self.assert_no_pattern({
            "save file picker": r"\bshowSaveFilePicker\b",
            "writable file stream": r"\bFileSystemWritableFileStream\b",
            "create writable": r"\bcreateWritable\s*\(",
            "remove entry": r"\bremoveEntry\s*\(",
            "file system move": r"\b(?:FileSystem\w+Handle\.)?move\s*\(",
            "file system truncate": r"\.truncate\s*\(",
            "write permission request": r"""mode\s*:\s*["']readwrite["']""",
        })
        for relative_path, source in self.sources.items():
            if relative_path == "storage/repositories.js":
                continue
            with self.subTest(file=relative_path, token="readwrite"):
                self.assertNotIn(
                    '"readwrite"',
                    source,
                    "readwrite is allowed only as an IndexedDB transaction mode",
                )

    def test_no_unsafe_html_dom_sink(self) -> None:
        self.assert_no_pattern({
            "innerHTML": r"\.innerHTML\b",
            "outerHTML": r"\.outerHTML\b",
            "insertAdjacentHTML": r"\.insertAdjacentHTML\s*\(",
            "document.write": r"\bdocument\.write\s*\(",
            "contextual fragment": r"\.createContextualFragment\s*\(",
            "unsafe HTML setter": r"\.setHTMLUnsafe\s*\(",
            "eval": r"\beval\s*\(",
            "Function constructor": r"\bnew\s+Function\s*\(",
        })

    def test_file_content_reads_are_confined_to_three_explicit_flows(self) -> None:
        allowed_readers = {
            "analysis/duplicate-worker.js",
            "pages/project-analysis.js",
            "pages/gitignore.js",
        }
        content_read_pattern = re.compile(
            r"\bFileReader\b"
            r"|\.readAs(?:ArrayBuffer|Text|DataURL|BinaryString)\s*\("
            r"|\.arrayBuffer\s*\("
            r"|\.text\s*\("
            r"|\.stream\s*\(",
        )
        found_in: set[str] = set()
        for relative_path, source in self.sources.items():
            if content_read_pattern.search(source):
                found_in.add(relative_path)
            with self.subTest(file=relative_path):
                self.assertFalse(
                    content_read_pattern.search(source)
                    and relative_path not in allowed_readers,
                    f"File content read appeared outside an approved flow: {relative_path}",
                )
        self.assertEqual(found_in, allowed_readers)

        duplicate_worker = self.sources["analysis/duplicate-worker.js"]
        self.assertIn(
            "await file.slice(offset, end).arrayBuffer()",
            duplicate_worker,
        )
        self.assertIn("const CHUNK_BYTES = 4 * 1024 * 1024", duplicate_worker)

        project_page = self.sources["pages/project-analysis.js"]
        self.assertIn("const text = await file.text();", project_page)
        self.assertIn("if (Number(file.size) > MAX_MANIFEST_SIZE)", project_page)

        gitignore_page = self.sources["pages/gitignore.js"]
        self.assertIn("(await file.text())", gitignore_page)
        self.assertIn("if (Number(file.size) > MAX_EXISTING_FILE_SIZE)", gitignore_page)

    def test_content_reads_are_gated_by_explicit_click_handlers(self) -> None:
        duplicates = self.sources["pages/duplicates.js"]
        self.assertEqual(len(re.findall(r"\bstartHashing\s*\(", duplicates)), 2)
        self.assertRegex(
            duplicates,
            r"""byId\(["']hash-start["']\)\?\.addEventListener\(["']click["']"""
            r"[\s\S]*?\bstartHashing\s*\(",
        )

        project = self.sources["pages/project-analysis.js"]
        self.assertEqual(
            len(re.findall(r"\binspectSelectedManifests\s*\(", project)),
            2,
        )
        self.assertRegex(
            project,
            r"""byId\(["']inspect-manifests["']\)\?\.addEventListener\(["']click["']"""
            r"[\s\S]*?\binspectSelectedManifests\s*\(",
        )

        gitignore = self.sources["pages/gitignore.js"]
        self.assertEqual(
            len(re.findall(r"\breadExistingGitignore\s*\(", gitignore)),
            2,
        )
        self.assertRegex(
            gitignore,
            r"""byId\(["']read-existing-gitignore["']\)\?\.addEventListener\(["']click["']"""
            r"[\s\S]*?\breadExistingGitignore\s*\(",
        )

        required_disclosures = {
            "duplicates.html": (
                "精密確認では、候補ファイルの内容をブラウザ内で読み取ってハッシュを計算します。",
                "ファイル内容はサーバへ送信されません。",
            ),
            "project_analysis.html": (
                "この操作を実行した場合だけ",
                "内容はサーバへ送信されません。",
            ),
            "gitignore.html": (
                "選択して読み込む場合だけ",
                "元ファイルは変更しません。",
            ),
        }
        for template_name, messages in required_disclosures.items():
            template = (TEMPLATES / template_name).read_text(encoding="utf-8")
            for message in messages:
                with self.subTest(template=template_name, message=message):
                    self.assertIn(message, template)

    def test_normal_analysis_reads_metadata_only(self) -> None:
        analyzer = self.sources["analysis/analyzer.js"]
        worker = self.sources["analysis-worker.js"]
        content_tokens = (
            "FileReader",
            ".readAsArrayBuffer(",
            ".readAsText(",
            ".arrayBuffer(",
            ".text(",
            ".stream(",
        )
        for token in content_tokens:
            with self.subTest(file="analysis/analyzer.js", token=token):
                self.assertNotIn(token, analyzer)
            with self.subTest(file="analysis-worker.js", token=token):
                self.assertNotIn(token, worker)
        for metadata_field in (
            "file.name",
            "file.webkitRelativePath",
            "file.size",
            "file.lastModified",
        ):
            with self.subTest(metadata=metadata_field):
                self.assertIn(metadata_field, analyzer)

    def test_file_inputs_cannot_be_serialized_by_fallback_form_submit(self) -> None:
        file_input_pattern = re.compile(
            r"""<input\b[^>]*\btype=["']file["'][^>]*>""",
            flags=re.IGNORECASE,
        )
        name_pattern = re.compile(r"""\bname\s*=""", flags=re.IGNORECASE)
        found = 0
        for template_path in sorted(TEMPLATES.glob("*.html")):
            source = template_path.read_text(encoding="utf-8")
            for file_input in file_input_pattern.findall(source):
                found += 1
                with self.subTest(template=template_path.name, input=file_input):
                    self.assertIsNone(
                        name_pattern.search(file_input),
                        "File inputs must not be successful form controls",
                    )
        self.assertGreater(found, 0)

    def test_csp_allows_adsense_but_blocks_native_form_submission(self) -> None:
        headers = SECURITY_HEADERS.read_text(encoding="utf-8")
        self.assertIn("connect-src 'self' https:", headers)
        self.assertIn("form-action 'none'", headers)
        self.assertIn("'strict-dynamic'", headers)
        self.assertIn("'nonce-{nonce}'", headers)

        nginx = NGINX_CONFIG.read_text(encoding="utf-8")
        self.assertNotIn("add_header Content-Security-Policy", nginx)


if __name__ == "__main__":
    unittest.main()
