from __future__ import annotations

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path

from folder_visualizer import create_app


ROOT = Path(__file__).resolve().parents[1]
INDEX_TEMPLATE = ROOT / "templates" / "index.html"
INDEX_MODULE = ROOT / "static" / "js" / "pages" / "index.js"
PAGE_UTILS_MODULE = ROOT / "static" / "js" / "pages" / "page-utils.js"
STYLESHEET = ROOT / "static" / "css" / "style.css"


class ElementInventory(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.by_id: dict[str, tuple[str, dict[str, str]]] = {}

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attributes = {name: value or "" for name, value in attrs}
        if identifier := attributes.get("id"):
            self.by_id[identifier] = (tag, attributes)


class MainDashboardContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.template = INDEX_TEMPLATE.read_text(encoding="utf-8")
        cls.module = INDEX_MODULE.read_text(encoding="utf-8")
        cls.page_utils = PAGE_UTILS_MODULE.read_text(encoding="utf-8")
        cls.styles = STYLESHEET.read_text(encoding="utf-8")
        app = create_app("testing")
        cls.html = app.test_client().get("/").get_data(as_text=True)
        cls.inventory = ElementInventory()
        cls.inventory.feed(cls.html)

    def test_initial_view_only_shows_the_analysis_entry(self) -> None:
        entry = self.inventory.by_id["pre-analysis-view"][1]
        dashboard = self.inventory.by_id["post-analysis-view"][1]
        self.assertNotIn("hidden", entry.get("class", "").split())
        self.assertIn("hidden", dashboard.get("class", "").split())
        self.assertIn('id="analyze-form"', self.html)
        self.assertIn("disabled", self.inventory.by_id["analyze-button"][1])
        self.assertNotIn('class="hero-copy"', self.html)
        self.assertIn(
            'data-plotly-url="/assets/1.1.0/vendor/plotly.min.js"',
            self.html,
        )

        layout = re.search(
            r"function syncPrimaryLayout\(.*?(?=\nfunction openAnalysisForm)",
            self.module,
            re.DOTALL,
        )
        self.assertIsNotNone(layout)
        self.assertIn(
            "available && state.ready && !state.formOpen && !state.busy",
            layout.group(),
        )
        self.assertIn('"pre-analysis-view"', layout.group())
        self.assertIn('"post-analysis-view"', layout.group())

    def test_analysis_overview_has_three_vertical_facts(self) -> None:
        overview = self.inventory.by_id["overview-panel"][1]
        self.assertNotIn("hidden", overview.get("class", "").split())
        self.assertEqual(overview.get("role"), "tabpanel")

        facts = re.search(
            r'<dl class="overview-facts">(?P<body>.*?)</dl>',
            self.template,
            re.DOTALL,
        )
        self.assertIsNotNone(facts)
        self.assertEqual(facts.group("body").count("<dt>"), 3)
        for label, identifier in (
            ("選択フォルダ", "overview-folder"),
            ("合計容量", "overview-total-size"),
            ("合計ファイル数", "overview-total-files"),
        ):
            self.assertIn(label, facts.group("body"))
            self.assertIn(f'id="{identifier}"', facts.group("body"))

        self.assertRegex(
            self.styles,
            r"\.overview-facts\s*>\s*div\s*\{[^}]*display:\s*grid;",
        )

    def test_interactive_chart_uses_small_saved_aggregates_and_loads_lazily(self) -> None:
        self.assertIn('id="main-category-chart"', self.html)
        self.assertIn('id="main-chart-status"', self.html)
        self.assertIn("Interactive chart", self.html)
        self.assertNotIn('src="/plotly.js"', self.html)
        self.assertIn('data-chart-metric="size"', self.html)
        self.assertIn('data-chart-metric="count"', self.html)
        self.assertIn('id="capacity-distribution-body"', self.html)
        self.assertEqual(
            self.inventory.by_id["capacity-distribution-table"][1].get("tabindex"),
            "0",
        )
        self.assertEqual(
            self.inventory.by_id["capacity-distribution-table"][1].get("role"),
            "region",
        )
        self.assertIn("<caption", self.html)
        self.assertIn('scope="col"', self.html)
        self.assertIn('scope: "row"', self.module)
        self.assertIn("meta?.categoryStats", self.module)
        self.assertIn("Storage.getExtensions()", self.module)

        distribution_code = re.search(
            r"function categoryRows\(.*?(?=\nfunction loadPlotly)",
            self.module,
            re.DOTALL,
        )
        self.assertIsNotNone(distribution_code)
        self.assertNotIn("queryFileIds", distribution_code.group())
        self.assertNotIn("getFilesByIds", distribution_code.group())
        self.assertNotIn("FileReader", distribution_code.group())
        self.assertIn('document.createElement("script")', self.module)
        self.assertIn("window.Plotly?.react", self.module)
        self.assertIn("!state.status?.available", self.module)
        self.assertIn("!dashboardIsVisible()", self.module)
        self.assertIn("Plotly.react(chart", self.module)
        self.assertIn("buildMainUrl({ category: row.category })", self.module)
        self.assertIn("window.location.assign(buildMainUrl({ category }))", self.module)
        self.assertIn('className: "capacity-ratio-layout"', self.module)
        for category in (
            "source-code",
            "document",
            "image",
            "video",
            "audio",
            "archive",
            "data",
            "executable",
            "font",
            "temporary",
            "log",
            "backup",
            "no-extension",
            "other",
        ):
            self.assertIn(f'<option value="{category}">', self.template)

    def test_submit_is_bound_before_storage_initialization_and_errors_are_visible(self) -> None:
        initialize = re.search(
            r"async function initialize\(\).*?(?=\n\}\n\ninitializeWhenReady)",
            self.module,
            re.DOTALL,
        )
        self.assertIsNotNone(initialize)
        source = initialize.group()
        self.assertLess(source.index("bindInterface();"), source.index("await Storage.getSettings()"))
        self.assertIn('showMessage(\n      "form-message"', source)

        bindings = re.search(
            r"function bindInterface\(\).*?(?=\nasync function initializeVirtualTable)",
            self.module,
            re.DOTALL,
        )
        self.assertIsNotNone(bindings)
        self.assertIn('byId("analyze-form")?.addEventListener("submit"', bindings.group())
        self.assertIn("event.preventDefault()", bindings.group())

    def test_file_list_and_analysis_menu_are_button_controlled(self) -> None:
        for identifier, view in (
            ("overview-view-button", "overview"),
            ("files-view-button", "files"),
            ("analysis-view-button", "analysis"),
        ):
            tag, attributes = self.inventory.by_id[identifier]
            self.assertEqual(tag, "button")
            self.assertEqual(attributes.get("role"), "tab")
            self.assertEqual(attributes.get("data-main-view"), view)
        self.assertEqual(
            self.inventory.by_id["overview-view-button"][1].get("aria-selected"),
            "true",
        )
        self.assertEqual(
            self.inventory.by_id["files-view-button"][1].get("tabindex"),
            "-1",
        )
        self.assertEqual(
            self.inventory.by_id["analysis-view-button"][1].get("tabindex"),
            "-1",
        )

        self.assertIn(
            "hidden",
            self.inventory.by_id["file-panel"][1].get("class", "").split(),
        )
        self.assertIn(
            "hidden",
            self.inventory.by_id["analysis-actions"][1].get("class", "").split(),
        )
        self.assertIn('document.querySelectorAll("[data-main-panel]")', self.module)
        self.assertIn('button.setAttribute("aria-selected"', self.module)
        self.assertIn('aria-orientation="horizontal"', self.html)

    def test_file_query_is_lazy_but_url_filters_open_the_file_view(self) -> None:
        self.assertIn('if (raw === null || raw.trim() === "")', self.page_utils)
        load_analysis = re.search(
            r"async function loadAnalysis\(.*?(?=\nasync function startAnalysis)",
            self.module,
            re.DOTALL,
        )
        self.assertIsNotNone(load_analysis)
        source = load_analysis.group()
        self.assertIn('params.has("savedSearch")', source)
        self.assertIn("Object.keys(queryFromUrl()).length > 0", source)
        self.assertIsNotNone(
            re.search(
                r'if \(requestedByUrl \|\| state\.currentView === "files" '
                r'\|\| options\.loadFiles\) \{.*?await runQuery\(',
                source,
                re.DOTALL,
            ),
        )
        self.assertIn("ファイル一覧を開くと読み込みます。", source)

        activation = re.search(
            r"async function activateMainView\(.*?(?=\nfunction bindMainViewSwitcher)",
            self.module,
            re.DOTALL,
        )
        self.assertIsNotNone(activation)
        self.assertIn('view === "files"', activation.group())
        self.assertIn("await runQuery({ initial: true })", activation.group())

    def test_tabs_support_keyboard_navigation(self) -> None:
        for key in ("ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"):
            self.assertIn(f'event.key === "{key}"', self.module)
        self.assertIn('button.setAttribute("tabindex", active ? "0" : "-1")', self.module)
        self.assertIn("buttons.filter((item) => !item.disabled)", self.module)

    def test_palette_is_cool_and_old_warm_accents_are_gone(self) -> None:
        for token in (
            "--bg: #eaf1f9",
            "--accent: #3b6fd8",
            "--accent-strong: #244da6",
            "--secondary: #14768c",
        ):
            self.assertIn(token, self.styles)
        for warm_value in (
            "#bf5f2d",
            "#8d3b13",
            "rgba(191, 95, 45",
            "rgba(91, 76, 63",
        ):
            self.assertNotIn(warm_value, self.styles)


if __name__ == "__main__":
    unittest.main()
