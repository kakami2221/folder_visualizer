from __future__ import annotations

import unittest
import xml.etree.ElementTree as ElementTree
from html.parser import HTMLParser

from folder_visualizer import create_app
from folder_visualizer.routes.pages import PAGE_ROUTES
from folder_visualizer.routes.seo import (
    ADS_TXT_ENTRIES,
    PUBLIC_SITEMAP_URLS,
    SEO_PAGES,
)


class SeoDocumentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: list[str] = []
        self.canonicals: list[str] = []
        self.descriptions: list[str] = []
        self.h1_parts: list[list[str]] = []
        self.robots_directives: list[str] = []
        self.title_parts: list[str] = []
        self._h1_depth = 0
        self._in_title = False

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attributes = {name.lower(): value or "" for name, value in attrs}
        if tag == "a":
            self.anchors.append(attributes.get("href", ""))
        elif tag == "link" and "canonical" in attributes.get("rel", "").lower().split():
            self.canonicals.append(attributes.get("href", ""))
        elif tag == "meta" and attributes.get("name", "").lower() == "description":
            self.descriptions.append(attributes.get("content", ""))
        elif tag == "meta" and attributes.get("name", "").lower() == "robots":
            self.robots_directives.append(attributes.get("content", ""))
        elif tag == "h1":
            self._h1_depth += 1
            self.h1_parts.append([])
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "h1" and self._h1_depth:
            self._h1_depth -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._h1_depth:
            self.h1_parts[-1].append(data)
        if self._in_title:
            self.title_parts.append(data)

    @property
    def h1_texts(self) -> list[str]:
        return ["".join(parts).strip() for parts in self.h1_parts]

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()


class SearchDiscoveryContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app("testing")
        cls.client = cls.app.test_client()

    def parse_page(self, path: str) -> tuple[object, SeoDocumentParser]:
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        parser = SeoDocumentParser()
        parser.feed(response.get_data(as_text=True))
        return response, parser

    def test_sitemap_is_xml_with_only_the_six_canonical_public_urls(self) -> None:
        response = self.client.get("/sitemap.xml")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/xml")

        root = ElementTree.fromstring(response.data)
        namespace = {"sitemap": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        locations = [
            element.text
            for element in root.findall("sitemap:url/sitemap:loc", namespace)
        ]
        self.assertEqual(tuple(locations), PUBLIC_SITEMAP_URLS)
        self.assertEqual(len(locations), 6)
        self.assertEqual(len(locations), len(set(locations)))

    def test_robots_allows_crawling_and_advertises_the_sitemap(self) -> None:
        response = self.client.get("/robots.txt")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/plain")
        self.assertEqual(
            response.get_data(as_text=True).strip(),
            "User-agent: *\nAllow: /\n\n"
            "Sitemap: https://www.foldervisualizer.com/sitemap.xml",
        )
        self.assertNotIn("Disallow:", response.get_data(as_text=True))

    def test_ads_txt_declares_the_adsense_publisher_at_the_site_root(self) -> None:
        response = self.client.get("/ads.txt")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/plain")
        self.assertEqual(
            response.get_data(as_text=True).strip().splitlines(),
            list(ADS_TXT_ENTRIES),
        )
        self.assertEqual(
            ADS_TXT_ENTRIES,
            ("google.com, pub-4828937971968269, DIRECT, f08c47fec0942fa0",),
        )
        self.assertNotIn("ca-pub-", response.get_data(as_text=True))

    def test_every_seo_page_has_unique_metadata_and_one_h1(self) -> None:
        seen_titles: set[str] = set()
        seen_descriptions: set[str] = set()
        for page in SEO_PAGES:
            with self.subTest(path=page["path"]):
                _response, parser = self.parse_page(str(page["path"]))
                self.assertEqual(parser.title, page["title"])
                self.assertEqual(parser.descriptions, [page["description"]])
                self.assertEqual(parser.canonicals, [page["canonical"]])
                self.assertEqual(parser.h1_texts, [page["h1"]])
                seen_titles.add(parser.title)
                seen_descriptions.add(parser.descriptions[0])

        self.assertEqual(len(seen_titles), len(SEO_PAGES))
        self.assertEqual(len(seen_descriptions), len(SEO_PAGES))

    def test_public_html_pages_do_not_emit_noindex(self) -> None:
        public_paths = [path for path, _endpoint, _template in PAGE_ROUTES]
        public_paths.extend(str(page["path"]) for page in SEO_PAGES)

        for path in public_paths:
            with self.subTest(path=path):
                response, parser = self.parse_page(path)
                self.assertFalse(
                    any("noindex" in directive.lower() for directive in parser.robots_directives)
                )
                self.assertNotIn(
                    "noindex",
                    ",".join(response.headers.getlist("X-Robots-Tag")).lower(),
                )

    def test_home_and_seo_pages_use_crawlable_internal_links(self) -> None:
        seo_paths = {str(page["path"]) for page in SEO_PAGES}
        _home_response, home = self.parse_page("/")
        self.assertTrue(seo_paths.issubset(set(home.anchors)))

        for page in SEO_PAGES:
            path = str(page["path"])
            with self.subTest(path=path):
                _response, parser = self.parse_page(path)
                expected_related = seo_paths - {path}
                self.assertTrue(expected_related.issubset(set(parser.anchors)))
                self.assertIn("/", parser.anchors)
                self.assertIn("/#folder-analysis", parser.anchors)

        for path in sorted(seo_paths):
            with self.subTest(target=path):
                self.assertEqual(self.client.get(path).status_code, 200)


if __name__ == "__main__":
    unittest.main()
