from __future__ import annotations

import unittest
from html.parser import HTMLParser

from folder_visualizer import create_app


TITLE = "フォルダ内容・容量を可視化する無料Webツール | Folder Visualizer"
DESCRIPTION = (
    "フォルダ内容やフォルダ構造をブラウザ上で可視化できる無料Webツールです。"
    "容量分布、大容量ファイル、重複候補、古いファイルをインストール不要で分析できます。"
)


class HomeSeoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.h1_parts: list[list[str]] = []
        self.descriptions: list[str] = []
        self.canonicals: list[str] = []
        self._in_title = False
        self._h1_depth = 0

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attributes = {name: value or "" for name, value in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "h1":
            self._h1_depth += 1
            self.h1_parts.append([])
        elif tag == "meta" and attributes.get("name") == "description":
            self.descriptions.append(attributes.get("content", ""))
        elif tag == "link" and attributes.get("rel") == "canonical":
            self.canonicals.append(attributes.get("href", ""))

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "h1" and self._h1_depth:
            self._h1_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        if self._h1_depth:
            self.h1_parts[-1].append(data)


class HomeSeoContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        app = create_app("testing")
        cls.html = app.test_client().get("/").get_data(as_text=True)
        cls.parser = HomeSeoParser()
        cls.parser.feed(cls.html)

    def test_title_description_and_canonical_are_unique(self) -> None:
        self.assertEqual("".join(self.parser.title_parts).strip(), TITLE)
        self.assertEqual(self.parser.descriptions, [DESCRIPTION])
        self.assertEqual(
            self.parser.canonicals,
            ["https://www.foldervisualizer.com/"],
        )

    def test_home_page_has_one_descriptive_h1(self) -> None:
        h1_text = ["".join(parts).strip() for parts in self.parser.h1_parts]
        self.assertEqual(h1_text, ["フォルダ内容・容量をブラウザで可視化"])
        self.assertIn("<h2 id=\"folder-selection-title\">解析するフォルダを選択</h2>", self.html)
        self.assertIn("<h2 id=\"analysis-dashboard-title\">解析結果</h2>", self.html)

    def test_required_home_sections_and_steps_are_present(self) -> None:
        for heading in (
            "フォルダの中身を見やすく可視化",
            "大容量ファイルや不要ファイルを発見",
            "インストール不要でブラウザ内解析",
            "使い方",
            "よくある質問",
        ):
            with self.subTest(heading=heading):
                self.assertIn(heading, self.html)

        for step in (
            "解析したいフォルダを選択する",
            "ブラウザ内でフォルダ情報を解析する",
            "グラフや一覧から容量、構造、整理候補を確認する",
        ):
            with self.subTest(step=step):
                self.assertIn(step, self.html)

    def test_faq_is_static_and_accessible_without_javascript(self) -> None:
        self.assertEqual(self.html.count('<details class="faq-item">'), 4)
        self.assertIn("Folder Visualizerは無料で利用できますか？", self.html)
        self.assertIn("フォルダ内のファイルはサーバーへアップロードされますか？", self.html)
        self.assertIn("ソフトのインストールは必要ですか？", self.html)
        self.assertIn("どのような情報を確認できますか？", self.html)


if __name__ == "__main__":
    unittest.main()
