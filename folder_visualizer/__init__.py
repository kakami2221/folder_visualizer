"""Folder Visualizer Flask application factory."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from flask import Flask, render_template
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import get_config
from .routes.assets import asset_url, register_asset_routes
from .routes.health import register_health_routes
from .routes.pages import register_page_routes
from .routes.seo import SEO_PAGES, register_seo_routes
from .security.headers import register_response_policies
from .utils.logging import configure_app_logging


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def create_app(config: dict[str, Any] | str | None = None) -> Flask:
    """Create an isolated Flask application.

    ``config`` accepts a configuration mapping for tests or one of the
    environment names supported by :func:`get_config`.
    """

    app = Flask(
        __name__,
        static_folder=str(PROJECT_ROOT / "static"),
        static_url_path="/static",
        template_folder=str(PROJECT_ROOT / "templates"),
    )

    if isinstance(config, str) or config is None:
        app.config.from_object(get_config(config))
    else:
        app.config.from_object(get_config(None))
        app.config.from_mapping(config)

    # A production process must never inherit development debug mode.
    if app.config.get("ENVIRONMENT_NAME") == "production":
        app.config["DEBUG"] = False
        app.config["TESTING"] = False

    if app.config.get("TRUST_PROXY_HEADERS"):
        app.wsgi_app = ProxyFix(  # type: ignore[method-assign]
            app.wsgi_app,
            x_for=1,
            x_proto=1,
            x_host=1,
            x_port=1,
        )

    configure_app_logging(app)
    register_asset_routes(app)
    register_page_routes(app)
    register_seo_routes(app)
    register_health_routes(app)
    register_response_policies(app)
    register_error_handlers(app)

    @app.context_processor
    def inject_application_metadata() -> dict[str, object]:
        def public_config_value(name: str) -> str:
            value = app.config.get(name, "")
            return value.strip() if isinstance(value, str) else ""

        return {
            "app_version": str(app.config["APP_VERSION"]),
            "asset_url": asset_url,
            "adsense_client_id": str(app.config.get("ADSENSE_CLIENT_ID", "")),
            "contact_email": public_config_value("CONTACT_EMAIL"),
            "privacy_effective_date": public_config_value(
                "PRIVACY_EFFECTIVE_DATE"
            ),
            "privacy_last_updated_date": public_config_value(
                "PRIVACY_LAST_UPDATED_DATE"
            ),
            "terms_effective_date": public_config_value("TERMS_EFFECTIVE_DATE"),
            "terms_last_updated_date": public_config_value(
                "TERMS_LAST_UPDATED_DATE"
            ),
            "current_year": date.today().year,
            "seo_guides": SEO_PAGES,
        }

    return app


def register_error_handlers(app: Flask) -> None:
    """Install safe error pages which never expose exception details."""

    @app.errorhandler(404)
    def not_found(_error: Exception):
        return render_template("404.html"), 404

    @app.errorhandler(500)
    def internal_server_error(_error: Exception):
        # Log only the stable URL path. Query strings can contain local search
        # terms, so they are deliberately omitted from all application logs.
        app.logger.error("Unhandled server error while rendering a page")
        return render_template("500.html"), 500
