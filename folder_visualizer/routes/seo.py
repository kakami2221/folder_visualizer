"""Public SEO landing pages and search-engine discovery routes."""

from __future__ import annotations

from typing import Any, Callable

from flask import Flask, Response, current_app, render_template


PUBLIC_SITE_ORIGIN = "https://www.foldervisualizer.com"

SEO_PAGES: tuple[dict[str, Any], ...] = (
    {
        "path": "/folder-visualization",
        "endpoint": "folder_visualization",
        "heading_id": "folder-visualization-title",
        "title": "フォルダ内容を可視化する無料オンラインツール | Folder Visualizer",
        "description": (
            "フォルダ内のファイル、階層、容量分布をブラウザ上で見やすく可視化する方法を紹介します。"
            "TreemapやSunburstも無料で確認できます。"
        ),
        "canonical": f"{PUBLIC_SITE_ORIGIN}/folder-visualization",
        "h1": "フォルダ内容をブラウザで可視化",
        "link_label": "フォルダ内容を可視化する方法",
        "link_description": "ファイル一覧や容量分布をまとめて把握する方法を紹介",
        "intro": (
            "フォルダ内のファイルや階層、容量の偏りを一つの画面で確認すると、"
            "必要なデータと整理候補を効率よく把握できます。"
        ),
        "sections": (
            {
                "heading": "フォルダ可視化とは",
                "paragraphs": (
                    "フォルダ可視化は、ファイル名や保存場所、容量などの情報を一覧やグラフに整理し、全体像を確認しやすくする方法です。フォルダーを一つずつ開いて調べる手間を減らせます。",
                ),
                "bullets": (),
            },
            {
                "heading": "構造と容量を可視化するメリット",
                "paragraphs": (
                    "階層と使用容量を同時に見ることで、データが集中している場所や、想定外に大きくなったフォルダを見つけやすくなります。整理前の状況確認にも役立ちます。",
                ),
                "bullets": (
                    "フォルダ内にあるファイルを一覧で確認する",
                    "容量を多く使用している場所を比較する",
                    "古いファイルや重複候補などの整理材料を確認する",
                ),
            },
            {
                "heading": "Folder Visualizerで利用できる表示方法",
                "paragraphs": (
                    "ファイル一覧に加え、面積で容量差を比べるTreemap、中心から外側へ階層をたどるSunburstを利用できます。パスや階層情報も確認できるため、ツリーとして構造を追いたい場合にも役立ちます。",
                ),
                "bullets": (),
            },
            {
                "heading": "フォルダを可視化する手順",
                "paragraphs": (
                    "トップページで解析したいフォルダを選択し、ブラウザ内の解析が完了したら、概要、ファイル一覧、構造などの各画面を開いて確認します。",
                ),
                "bullets": (),
            },
        ),
    },
    {
        "path": "/folder-size-visualizer",
        "endpoint": "folder_size_visualizer",
        "heading_id": "folder-size-visualizer-title",
        "title": "フォルダごとの容量を可視化・確認する無料ツール | Folder Visualizer",
        "description": (
            "フォルダごとの使用容量をブラウザで可視化し、容量の大きい場所を確認する方法を紹介します。"
            "インストール不要で無料利用できます。"
        ),
        "canonical": f"{PUBLIC_SITE_ORIGIN}/folder-size-visualizer",
        "h1": "フォルダごとの容量を可視化・確認",
        "link_label": "フォルダごとの容量を確認する方法",
        "link_description": "容量の大きいフォルダや空き容量不足の原因を調査",
        "intro": (
            "フォルダ単位の使用容量を比較すると、PCのストレージを多く使っている場所を効率よく絞り込めます。"
        ),
        "sections": (
            {
                "heading": "フォルダ容量を調べる方法",
                "paragraphs": (
                    "Folder Visualizerでフォルダを解析すると、選択範囲の合計容量と、フォルダごとの容量を確認できます。ファイルを個別に開く必要はありません。",
                ),
                "bullets": (),
            },
            {
                "heading": "容量の大きいフォルダを探す",
                "paragraphs": (
                    "大容量フォルダ画面では、フォルダを使用容量やファイル数で比較できます。上位から確認することで、ストレージ使用量の大きな場所を見つけやすくなります。",
                ),
                "bullets": (),
            },
            {
                "heading": "PCの空き容量が少ないときの確認ポイント",
                "paragraphs": (
                    "まず容量の大きなフォルダを確認し、その中にある大容量ファイル、古いファイル、重複候補を順番に調べると、整理対象を判断しやすくなります。",
                ),
                "bullets": (
                    "ダウンロードや動画など容量が増えやすい場所を確認する",
                    "更新日時と用途を確かめてから整理を検討する",
                    "バックアップの有無を確認する",
                ),
            },
            {
                "heading": "Treemapで容量差を見比べる",
                "paragraphs": (
                    "Treemapは使用容量を面積で表すため、容量の偏りを視覚的に把握しやすい表示です。大きな領域から階層をたどることで、確認すべき場所を絞り込めます。",
                ),
                "bullets": (),
            },
        ),
    },
    {
        "path": "/find-large-files",
        "endpoint": "find_large_files",
        "heading_id": "find-large-files-title",
        "title": "大容量ファイルを探す無料ブラウザツール | Folder Visualizer",
        "description": (
            "容量の大きいファイルをサイズ順に確認し、PCの容量不足を調査する方法を紹介します。"
            "ファイルをアップロードせずブラウザ内で分析できます。"
        ),
        "canonical": f"{PUBLIC_SITE_ORIGIN}/find-large-files",
        "h1": "容量の大きいファイルをブラウザで探す",
        "link_label": "大容量ファイルを探す方法",
        "link_description": "ファイルサイズ順の確認方法と整理前の注意点を紹介",
        "intro": (
            "ストレージ不足の原因を調べるときは、容量の大きいファイルから用途と更新日時を確認すると効率的です。"
        ),
        "sections": (
            {
                "heading": "大容量ファイルを探す目的",
                "paragraphs": (
                    "動画、アーカイブ、バックアップなどの大きなファイルは、少数でもストレージを大きく使用します。容量不足の原因を把握するため、まずサイズの大きな項目を確認します。",
                ),
                "bullets": (),
            },
            {
                "heading": "ファイルサイズ順で確認する方法",
                "paragraphs": (
                    "フォルダ解析後に大容量ファイル画面を開くと、ファイルをサイズ順に確認できます。名前や保存場所、更新日時も見ながら用途を判断できます。",
                ),
                "bullets": (),
            },
            {
                "heading": "PCの容量不足を調査する流れ",
                "paragraphs": (
                    "合計容量と種類別の分布を確認した後、大容量フォルダ、大容量ファイルの順に対象を絞り込みます。古いファイルや重複候補の画面も、整理候補を探す参考になります。",
                ),
                "bullets": (),
            },
            {
                "heading": "整理する前に確認すること",
                "paragraphs": (
                    "ファイルの用途、作成元、バックアップ、ほかのアプリから参照されていないかを確認してください。Folder Visualizerは候補の確認を支援するツールで、ファイルを削除、移動、変更する機能はありません。",
                ),
                "bullets": (),
            },
        ),
    },
    {
        "path": "/folder-structure-visualizer",
        "endpoint": "folder_structure_visualizer",
        "heading_id": "folder-structure-visualizer-title",
        "title": "フォルダ構造をツリー・Treemapで可視化するツール | Folder Visualizer",
        "description": (
            "フォルダ構造を階層、Treemap、Sunburstで可視化し、保存場所や容量の偏りを確認する方法を紹介します。"
        ),
        "canonical": f"{PUBLIC_SITE_ORIGIN}/folder-structure-visualizer",
        "h1": "フォルダ構造をツリーやグラフで可視化",
        "link_label": "フォルダ構造を可視化する方法",
        "link_description": "階層、Treemap、Sunburstそれぞれの見方を紹介",
        "intro": (
            "フォルダ階層を見える形にすると、保存場所の深さやデータの集中している場所を把握しやすくなります。"
        ),
        "sections": (
            {
                "heading": "フォルダ階層を可視化するメリット",
                "paragraphs": (
                    "階層全体を見渡すことで、深く入り組んだ保存場所、似た名前のフォルダ、容量が集中している枝を効率よく確認できます。",
                ),
                "bullets": (),
            },
            {
                "heading": "ツリーとして階層をたどる",
                "paragraphs": (
                    "フォルダ名と相対パスを親子関係に沿って確認すると、一般的なツリー表示と同じように保存場所を上位から下位へたどれます。",
                ),
                "bullets": (),
            },
            {
                "heading": "TreemapとSunburstの特徴",
                "paragraphs": (
                    "Treemapは容量差を面積で比較する表示です。Sunburstは中心から外側へ向かって階層を表すため、どの枝にデータが属しているかを確認しやすくなります。",
                ),
                "bullets": (
                    "Treemap：容量の大きな領域を素早く見つける",
                    "Sunburst：階層のつながりを放射状に確認する",
                ),
            },
            {
                "heading": "開発プロジェクトや資料フォルダの確認例",
                "paragraphs": (
                    "開発プロジェクトでは依存関係や生成物が集まる場所を、資料フォルダでは画像、動画、書類が集中する階層を確認できます。内容を整理する前の現状把握に利用できます。",
                ),
                "bullets": (),
            },
        ),
    },
)

PUBLIC_SITEMAP_URLS = (
    f"{PUBLIC_SITE_ORIGIN}/",
    *(str(page["canonical"]) for page in SEO_PAGES),
    f"{PUBLIC_SITE_ORIGIN}/privacy",
)


def _seo_page_renderer(page: dict[str, Any]) -> Callable[[], str]:
    def render_page() -> str:
        return render_template(
            "seo_page.html",
            page=page,
            current_seo_endpoint=page["endpoint"],
        )

    return render_page


def sitemap() -> Response:
    """Return the canonical, fixed list of indexable landing pages."""

    return current_app.response_class(
        render_template("sitemap.xml", sitemap_urls=PUBLIC_SITEMAP_URLS),
        mimetype="application/xml",
    )


def robots() -> Response:
    """Allow crawling and advertise the canonical sitemap location."""

    return current_app.response_class(
        render_template(
            "robots.txt",
            sitemap_url=f"{PUBLIC_SITE_ORIGIN}/sitemap.xml",
        ),
        mimetype="text/plain",
    )


def register_seo_routes(app: Flask) -> None:
    """Register SEO landing pages and read-only discovery endpoints."""

    for page in SEO_PAGES:
        app.add_url_rule(
            str(page["path"]),
            endpoint=str(page["endpoint"]),
            view_func=_seo_page_renderer(page),
            methods=["GET"],
        )

    app.add_url_rule(
        "/sitemap.xml",
        endpoint="sitemap",
        view_func=sitemap,
        methods=["GET"],
    )
    app.add_url_rule(
        "/robots.txt",
        endpoint="robots",
        view_func=robots,
        methods=["GET"],
    )
