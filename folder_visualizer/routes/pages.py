"""Read-only HTML page routes."""

from __future__ import annotations

from typing import Callable

from flask import Flask, render_template


PAGE_ROUTES = (
    ("/", "index", "index.html"),
    ("/summary", "summary", "summary.html"),
    ("/structure", "structure", "structure.html"),
    ("/extensions", "extensions", "extensions.html"),
    ("/age-distribution", "age_distribution", "age_distribution.html"),
    ("/large-files", "large_files", "large_files.html"),
    ("/large-directories", "large_directories", "large_directories.html"),
    ("/cleanup", "cleanup", "cleanup.html"),
    ("/duplicates", "duplicates", "duplicates.html"),
    ("/history", "history", "history.html"),
    ("/saved-searches", "saved_searches", "saved_searches.html"),
    ("/health-score", "health_score", "health_score.html"),
    ("/project-analysis", "project_analysis", "project_analysis.html"),
    ("/gitignore", "gitignore", "gitignore.html"),
    ("/export", "export_data", "export.html"),
    ("/compare", "compare", "compare.html"),
    ("/settings", "settings", "settings.html"),
    ("/privacy", "privacy", "privacy.html"),
    ("/terms", "terms", "terms.html"),
    ("/contact", "contact", "contact.html"),
)

AD_FREE_ENDPOINTS = frozenset({"privacy", "terms", "contact"})


def _page_renderer(template_name: str, *, disable_ads: bool = False) -> Callable[[], str]:
    def render_page() -> str:
        return render_template(template_name, disable_ads=disable_ads)

    return render_page


def register_page_routes(app: Flask) -> None:
    """Register GET-only public pages while preserving legacy endpoint names."""

    for path, endpoint, template_name in PAGE_ROUTES:
        app.add_url_rule(
            path,
            endpoint=endpoint,
            view_func=_page_renderer(
                template_name,
                disable_ads=endpoint in AD_FREE_ENDPOINTS,
            ),
            methods=["GET"],
        )
