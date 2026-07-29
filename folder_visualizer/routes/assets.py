"""Versioned, same-origin asset delivery.

The version segment is part of every cacheable asset URL.  Only the version
configured for the running release is served, so an old immutable URL can
never start returning bytes from a newer release.
"""

from __future__ import annotations

import re
from http import HTTPStatus
from importlib import resources
from pathlib import PurePosixPath

from flask import (
    Flask,
    Response,
    abort,
    current_app,
    jsonify,
    send_from_directory,
    url_for,
)


PLOTLY_ASSET_PATH = "vendor/plotly.min.js"
APP_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}\Z")


def _normalized_asset_path(filename: str) -> str:
    """Return a safe relative POSIX path for a trusted template asset."""

    normalized = str(filename).replace("\\", "/").strip()
    path = PurePosixPath(normalized)
    if (
        not normalized
        or normalized.startswith("/")
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ValueError("Asset paths must be non-empty relative paths.")
    return path.as_posix()


def asset_url(filename: str) -> str:
    """Build a URL whose version segment changes with every application release."""

    return url_for(
        "versioned_asset",
        version=str(current_app.config["APP_VERSION"]),
        filename=_normalized_asset_path(filename),
    )


def _plotly_response() -> Response | tuple[Response, HTTPStatus]:
    """Return the Plotly bundle installed with the application."""

    try:
        bundle = resources.files("plotly") / "package_data" / "plotly.min.js"
        return current_app.response_class(
            bundle.read_text(encoding="utf-8"),
            mimetype="text/javascript",
        )
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return (
            jsonify({"error": "Plotly bundle is unavailable."}),
            HTTPStatus.INTERNAL_SERVER_ERROR,
        )


def versioned_asset(version: str, filename: str):
    """Serve one asset only when the URL version matches the running release."""

    if version != str(current_app.config["APP_VERSION"]):
        abort(404)

    try:
        normalized = _normalized_asset_path(filename)
    except ValueError:
        abort(404)
    if normalized == PLOTLY_ASSET_PATH:
        return _plotly_response()

    static_folder = current_app.static_folder
    if not static_folder:
        abort(404)
    return send_from_directory(static_folder, normalized, conditional=True)


def legacy_plotly_bundle():
    """Preserve the old endpoint without granting it immutable caching."""

    return _plotly_response()


def register_asset_routes(app: Flask) -> None:
    """Register cache-busted assets and temporary compatibility endpoints."""

    app_version = str(app.config.get("APP_VERSION", ""))
    if not APP_VERSION_PATTERN.fullmatch(app_version):
        raise RuntimeError(
            "APP_VERSION must be a non-empty URL-safe release identifier."
        )
    app.config["APP_VERSION"] = app_version

    app.add_url_rule(
        "/assets/<version>/<path:filename>",
        endpoint="versioned_asset",
        view_func=versioned_asset,
        methods=["GET"],
    )
    app.add_url_rule(
        "/plotly.js",
        endpoint="plotly_bundle",
        view_func=legacy_plotly_bundle,
        methods=["GET"],
    )
