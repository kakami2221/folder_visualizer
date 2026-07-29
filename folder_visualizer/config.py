"""Environment-backed configuration with production-safe defaults."""

from __future__ import annotations

import os
import secrets
from datetime import timedelta


def _as_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def _same_site() -> str:
    value = os.getenv("SESSION_COOKIE_SAMESITE", "Lax").strip().capitalize()
    return value if value in {"Lax", "Strict", "None"} else "Lax"


class BaseConfig:
    APP_VERSION = os.getenv("APP_VERSION", "1.1.0")
    APP_BASE_URL = os.getenv("APP_BASE_URL", "http://127.0.0.1:5000")
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
    APP_LOG_FILE = os.getenv("APP_LOG_FILE", "")
    SECRET_KEY = os.getenv("SECRET_KEY") or secrets.token_urlsafe(48)
    TRUST_PROXY_HEADERS = _as_bool("TRUST_PROXY_HEADERS", False)

    DEBUG = False
    TESTING = False
    MAX_CONTENT_LENGTH = 1024 * 1024
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SECURE = _as_bool("SESSION_COOKIE_SECURE", False)
    SESSION_COOKIE_SAMESITE = _same_site()
    PERMANENT_SESSION_LIFETIME = timedelta(hours=12)
    # Cacheability is assigned centrally by response policy.  The legacy
    # /static route must never inherit a long default lifetime.
    SEND_FILE_MAX_AGE_DEFAULT = 0
    VERSIONED_ASSET_MAX_AGE = 31_536_000
    JSON_SORT_KEYS = False


class DevelopmentConfig(BaseConfig):
    ENVIRONMENT_NAME = "development"
    DEBUG = _as_bool("FLASK_DEBUG", False)


class ProductionConfig(BaseConfig):
    ENVIRONMENT_NAME = "production"
    DEBUG = False
    SESSION_COOKIE_SECURE = _as_bool("SESSION_COOKIE_SECURE", True)
    TRUST_PROXY_HEADERS = _as_bool("TRUST_PROXY_HEADERS", True)


class TestingConfig(BaseConfig):
    ENVIRONMENT_NAME = "testing"
    TESTING = True
    SECRET_KEY = "test-only-secret"


CONFIGS = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
}


def get_config(name: str | None) -> type[BaseConfig]:
    requested = (name or os.getenv("FLASK_ENV", "development")).strip().lower()
    return CONFIGS.get(requested, DevelopmentConfig)
