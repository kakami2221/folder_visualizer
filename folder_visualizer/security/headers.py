"""Response security and cache policies."""

from __future__ import annotations

import secrets

from flask import Flask, Response, g, request


def _build_csp(nonce: str) -> str:
    """Return an AdSense-compatible policy bound to this response."""

    return "; ".join(
        (
            "default-src 'self'",
            "base-uri 'self'",
            "connect-src 'self' https:",
            "font-src 'self' data: https:",
            "form-action 'none'",
            "frame-ancestors 'none'",
            "frame-src https:",
            "img-src 'self' data: blob: https:",
            "object-src 'none'",
            (
                "script-src 'self' "
                f"'nonce-{nonce}' 'strict-dynamic' "
                "'unsafe-inline' 'unsafe-eval' https: http:"
            ),
            "script-src-attr 'none'",
            "style-src 'self' 'unsafe-inline' https:",
            "worker-src 'self' blob:",
        )
    )


def register_response_policies(app: Flask) -> None:
    @app.before_request
    def create_csp_nonce() -> None:
        g.csp_nonce = secrets.token_urlsafe(24)

    @app.context_processor
    def inject_csp_nonce() -> dict[str, str]:
        return {"csp_nonce": str(g.csp_nonce)}

    def set_no_cache(response: Response) -> None:
        response.cache_control.clear()
        response.cache_control.no_cache = True
        response.cache_control.max_age = 0
        response.cache_control.must_revalidate = True

    def set_immutable(response: Response) -> None:
        response.cache_control.clear()
        response.cache_control.public = True
        response.cache_control.max_age = int(
            app.config.get("VERSIONED_ASSET_MAX_AGE", 31_536_000)
        )
        response.cache_control.immutable = True

    @app.after_request
    def apply_response_policies(response: Response) -> Response:
        response.headers.setdefault(
            "Content-Security-Policy",
            _build_csp(str(g.csp_nonce)),
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault(
            "Permissions-Policy",
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
            "microphone=(), payment=(), usb=()",
        )

        if request.is_secure:
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )

        if response.status_code < 400 and request.path.startswith("/assets/"):
            if app.config.get("ENVIRONMENT_NAME") == "production":
                set_immutable(response)
            else:
                set_no_cache(response)
        elif response.status_code < 400 and (
            request.path.startswith("/static/")
            or request.path == "/plotly.js"
        ):
            set_no_cache(response)
        elif (
            response.status_code >= 400
            or response.mimetype == "text/html"
            or request.path == "/health"
        ):
            response.cache_control.no_store = True
            response.cache_control.private = True

        return response
