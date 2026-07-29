"""Minimal load-balancer health check."""

from __future__ import annotations

from flask import Flask, current_app, jsonify


def register_health_routes(app: Flask) -> None:
    def health():
        return jsonify(
            {
                "status": "ok",
                "version": str(current_app.config["APP_VERSION"]),
            }
        )

    app.add_url_rule("/health", endpoint="health", view_func=health, methods=["GET"])
