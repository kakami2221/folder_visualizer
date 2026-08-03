from __future__ import annotations

import re
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from folder_visualizer import create_app
from folder_visualizer.routes.pages import PAGE_ROUTES


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates"
STATIC_ROOT = (ROOT / "static").resolve()
STATIC_JS = (STATIC_ROOT / "js").resolve()
ADSENSE_SCRIPT_URL = (
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"
    "?client=ca-pub-4828937971968269"
)

EXPECTED_PAGE_MODULES = {
    "index.html": "js/pages/index.js",
    "summary.html": "js/pages/summary.js",
    "structure.html": "js/pages/structure.js",
    "extensions.html": "js/pages/extensions.js",
    "age_distribution.html": "js/pages/age-distribution.js",
    "large_files.html": "js/pages/large-files.js",
    "large_directories.html": "js/pages/large-directories.js",
    "cleanup.html": "js/pages/cleanup.js",
    "duplicates.html": "js/pages/duplicates.js",
    "history.html": "js/pages/history.js",
    "saved_searches.html": "js/pages/saved-searches.js",
    "health_score.html": "js/pages/health-score.js",
    "project_analysis.html": "js/pages/project-analysis.js",
    "gitignore.html": "js/pages/gitignore.js",
    "export.html": "js/pages/export.js",
    "compare.html": "js/pages/compare.js",
    "settings.html": "js/pages/settings.js",
    "privacy.html": None,
}

LITERAL_DOM_ID_RE = re.compile(
    r"""
    \b(?:
        byId
        |setText
        |showMessage
        |document\.getElementById
    )
    \(\s*["']([A-Za-z][\w:.-]*)["']
    """,
    re.VERBOSE,
)
DOCUMENT_SELECTOR_RE = re.compile(
    r"""\bdocument\.querySelector(?:All)?\(\s*(["'`])(.+?)\1\s*,?\s*\)""",
    re.DOTALL,
)
STATIC_IMPORT_RE = re.compile(
    r"""(?m)^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;""",
)
STATIC_REEXPORT_RE = re.compile(
    r"""(?m)^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']\s*;""",
)
DYNAMIC_MODULE_RE = re.compile(
    r"""\bimport\(\s*["']([^"']+)["']\s*\)""",
)
IMPORT_META_ASSET_RE = re.compile(
    r"""new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)""",
)
URL_FOR_RE = re.compile(r"""url_for\(\s*["']([^"']+)["']""")


class MarkupInventory(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.attribute_names: set[str] = set()
        self.class_names: set[str] = set()
        self.scripts: list[dict[str, str]] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attributes = {name: value or "" for name, value in attrs}
        self.attribute_names.update(attributes)
        if attributes.get("id"):
            self.ids.append(attributes["id"])
        self.class_names.update(attributes.get("class", "").split())
        if tag == "script":
            self.scripts.append(attributes)


def extract_import_specifiers(source: str) -> set[str]:
    specifiers = set(DYNAMIC_MODULE_RE.findall(source))
    specifiers.update(STATIC_IMPORT_RE.findall(source))
    specifiers.update(STATIC_REEXPORT_RE.findall(source))
    return specifiers


def function_parameter_id_references(source: str) -> set[str]:
    """Resolve simple helpers which pass a parameter into a DOM lookup."""

    references: set[str] = set()
    declaration = re.compile(
        r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{",
    )
    for match in declaration.finditer(source):
        name = match.group(1)
        parameters = [
            parameter.strip().split("=", 1)[0].strip()
            for parameter in match.group(2).split(",")
            if parameter.strip()
        ]
        if not parameters:
            continue

        # Page helper functions are small. Scanning up to the next declaration
        # avoids pretending to be a full JavaScript parser while still tracing
        # helpers such as renderBreakdown("target-id", rows).
        next_declaration = declaration.search(source, match.end())
        body_end = next_declaration.start() if next_declaration else len(source)
        body = source[match.end():body_end]
        dom_parameters = {
            parameter
            for parameter in parameters
            if re.search(
                rf"\b(?:byId|setText|showMessage|"
                rf"(?:document\.)?getElementById)\(\s*{re.escape(parameter)}\b",
                body,
            )
        }
        if not dom_parameters:
            continue
        for parameter in dom_parameters:
            position = parameters.index(parameter)
            call_pattern = re.compile(
                rf"\b{re.escape(name)}\(\s*"
                + (r"[^,\n]+,\s*" * position)
                + r"""["']([A-Za-z][\w:.-]*)["']""",
            )
            references.update(call_pattern.findall(source))
    return references


def array_id_references(source: str) -> set[str]:
    """Resolve literal ID arrays immediately consumed by a DOM callback."""

    references: set[str] = set()
    pattern = re.compile(
        r"\[(?P<items>[^\]]+)\]\.forEach\(\s*\((?P<parameter>[A-Za-z_$][\w$]*)\)"
        r"\s*=>\s*(?P<body>[\s\S]*?)\n\s*\}\s*\);",
    )
    for match in pattern.finditer(source):
        parameter = match.group("parameter")
        body = match.group("body")
        if not re.search(
            rf"\b(?:byId|(?:document\.)?getElementById)\(\s*{re.escape(parameter)}\b",
            body,
        ):
            continue
        references.update(
            re.findall(
                r"""["']([A-Za-z][\w:.-]*)["']""",
                match.group("items"),
            )
        )
    return references


class FrontendPageContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app("testing")
        cls.rendered: dict[str, tuple[str, MarkupInventory]] = {}
        with cls.app.test_client() as client:
            for path, _endpoint, _template in PAGE_ROUTES:
                response = client.get(path)
                html = response.get_data(as_text=True)
                inventory = MarkupInventory()
                inventory.feed(html)
                cls.rendered[path] = (html, inventory)

    def test_all_eighteen_page_routes_are_unique_and_render(self) -> None:
        self.assertEqual(len(PAGE_ROUTES), 18)
        paths = [path for path, _endpoint, _template in PAGE_ROUTES]
        endpoints = [endpoint for _path, endpoint, _template in PAGE_ROUTES]
        templates = [template for _path, _endpoint, template in PAGE_ROUTES]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(len(endpoints), len(set(endpoints)))
        self.assertEqual(len(templates), len(set(templates)))
        self.assertEqual(set(templates), set(EXPECTED_PAGE_MODULES))

        rules_by_endpoint = {
            rule.endpoint: rule
            for rule in self.app.url_map.iter_rules()
        }
        with self.app.test_client() as client:
            for path, endpoint, template in PAGE_ROUTES:
                with self.subTest(path=path):
                    self.assertTrue((TEMPLATES / template).is_file())
                    self.assertIn(endpoint, rules_by_endpoint)
                    self.assertEqual(rules_by_endpoint[endpoint].rule, path)
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(response.mimetype.startswith("text/html"))

    def test_every_literal_jinja_endpoint_exists(self) -> None:
        available_endpoints = {
            rule.endpoint
            for rule in self.app.url_map.iter_rules()
        }
        for template in TEMPLATES.glob("*.html"):
            source = template.read_text(encoding="utf-8")
            for endpoint in URL_FOR_RE.findall(source):
                with self.subTest(template=template.name, endpoint=endpoint):
                    self.assertIn(endpoint, available_endpoints)

    def test_each_page_loads_the_expected_module_entrypoint(self) -> None:
        asset_prefix = f"/assets/{self.app.config['APP_VERSION']}/"
        for path, _endpoint, template in PAGE_ROUTES:
            inventory = self.rendered[path][1]
            module_sources = [
                script.get("src", "")
                for script in inventory.scripts
                if script.get("type", "").lower() == "module"
            ]
            with self.subTest(path=path):
                base_source = f"{asset_prefix}js/pages/base.js"
                self.assertIn(base_source, module_sources)
                page_sources = [
                    source
                    for source in module_sources
                    if source.startswith(f"{asset_prefix}js/pages/")
                    and source != base_source
                ]
                expected = EXPECTED_PAGE_MODULES[template]
                self.assertEqual(
                    page_sources,
                    [] if expected is None else [f"{asset_prefix}{expected}"],
                )

    def test_rendered_script_assets_and_relative_module_graph_resolve(self) -> None:
        asset_prefix = f"/assets/{self.app.config['APP_VERSION']}/"
        module_entries: set[Path] = set()
        for path, (_html, inventory) in self.rendered.items():
            for script in inventory.scripts:
                source_url = script.get("src", "")
                if not source_url:
                    continue
                with self.subTest(path=path, source=source_url):
                    split = urlsplit(source_url)
                    if split.scheme:
                        self.assertEqual(source_url, ADSENSE_SCRIPT_URL)
                        self.assertEqual(script.get("crossorigin"), "anonymous")
                        self.assertIn("async", script)
                        self.assertTrue(script.get("nonce"))
                        continue
                    self.assertTrue(split.path.startswith(asset_prefix))
                    relative_path = split.path.removeprefix(asset_prefix)
                    if relative_path == "vendor/plotly.min.js":
                        continue
                    file_path = (STATIC_ROOT / relative_path).resolve()
                    self.assertTrue(file_path.is_relative_to(STATIC_ROOT))
                    self.assertTrue(file_path.is_file())
                    if script.get("type", "").lower() == "module":
                        module_entries.add(file_path)

        visited: set[Path] = set()

        def visit(module_path: Path) -> None:
            module_path = module_path.resolve()
            if module_path in visited:
                return
            visited.add(module_path)
            source = module_path.read_text(encoding="utf-8")
            module_specifiers = extract_import_specifiers(source)
            asset_specifiers = set(IMPORT_META_ASSET_RE.findall(source))
            for specifier in module_specifiers | asset_specifiers:
                with self.subTest(
                    module=module_path.relative_to(STATIC_JS),
                    specifier=specifier,
                ):
                    self.assertTrue(
                        specifier.startswith("."),
                        "Browser modules must use local relative imports.",
                    )
                    clean_specifier = specifier.split("?", 1)[0].split("#", 1)[0]
                    resolved = (module_path.parent / clean_specifier).resolve()
                    self.assertTrue(resolved.is_relative_to(STATIC_JS))
                    self.assertTrue(resolved.is_file())
                    if specifier in module_specifiers and resolved.suffix == ".js":
                        visit(resolved)

        for entry in module_entries:
            visit(entry)

    def test_templates_do_not_emit_legacy_asset_urls(self) -> None:
        for template in TEMPLATES.glob("*.html"):
            source = template.read_text(encoding="utf-8")
            with self.subTest(template=template.name):
                self.assertNotIn("url_for('static'", source)
                self.assertNotIn('url_for("static"', source)
                self.assertNotIn("plotly_bundle", source)

    def test_page_javascript_literal_dom_references_exist(self) -> None:
        for path, _endpoint, template in PAGE_ROUTES:
            expected_module = EXPECTED_PAGE_MODULES[template]
            module_paths = [STATIC_JS / "pages" / "base.js"]
            if expected_module is not None:
                module_paths.append(STATIC_ROOT / expected_module)
            source = "\n".join(
                module_path.read_text(encoding="utf-8")
                for module_path in module_paths
            )
            inventory = self.rendered[path][1]
            rendered_ids = set(inventory.ids)
            references = set(LITERAL_DOM_ID_RE.findall(source))
            references.update(function_parameter_id_references(source))
            references.update(array_id_references(source))
            if re.search(r"\bensureAnalysis\(\s*\)", source):
                references.update({
                    "empty-state",
                    "analysis-content",
                    "empty-state-message",
                })
            for referenced_id in sorted(references):
                with self.subTest(path=path, referenced_id=referenced_id):
                    self.assertIn(referenced_id, rendered_ids)

    def test_document_query_selectors_have_rendered_targets(self) -> None:
        for path, _endpoint, template in PAGE_ROUTES:
            expected_module = EXPECTED_PAGE_MODULES[template]
            module_paths = [STATIC_JS / "pages" / "base.js"]
            if expected_module is not None:
                module_paths.append(STATIC_ROOT / expected_module)
            source = "\n".join(
                module_path.read_text(encoding="utf-8")
                for module_path in module_paths
            )
            inventory = self.rendered[path][1]
            for _quote, selector in DOCUMENT_SELECTOR_RE.findall(source):
                referenced_ids = re.findall(r"#([A-Za-z][\w:.-]*)", selector)
                referenced_attributes = re.findall(
                    r"\[\s*([A-Za-z_:][\w:.-]*)",
                    selector,
                )
                referenced_classes = re.findall(
                    r"(?<![\w-])\.([A-Za-z_][\w-]*)",
                    selector,
                )
                for referenced_id in referenced_ids:
                    with self.subTest(path=path, selector=selector):
                        self.assertIn(referenced_id, inventory.ids)
                for attribute in referenced_attributes:
                    with self.subTest(path=path, selector=selector):
                        self.assertIn(attribute, inventory.attribute_names)
                for class_name in referenced_classes:
                    with self.subTest(path=path, selector=selector):
                        self.assertIn(class_name, inventory.class_names)

    def test_rendered_pages_have_no_duplicate_ids(self) -> None:
        for path, (_html, inventory) in self.rendered.items():
            duplicates = [
                identifier
                for identifier, count in Counter(inventory.ids).items()
                if count > 1
            ]
            with self.subTest(path=path):
                self.assertEqual(duplicates, [])


if __name__ == "__main__":
    unittest.main()
