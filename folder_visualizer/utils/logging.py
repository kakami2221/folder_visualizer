"""Privacy-preserving application logging."""

from __future__ import annotations

import logging
from logging.handlers import WatchedFileHandler
from pathlib import Path

from flask import Flask


LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_app_logging(app: Flask) -> None:
    """Configure lifecycle/error logging without request metadata."""

    level_name = str(app.config.get("LOG_LEVEL", "INFO")).upper()
    level = getattr(logging, level_name, logging.INFO)
    formatter = logging.Formatter(LOG_FORMAT)

    log_file = str(app.config.get("APP_LOG_FILE", "")).strip()
    if log_file:
        path = Path(log_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = WatchedFileHandler(path, encoding="utf-8")
    else:
        handler = logging.StreamHandler()

    handler.setFormatter(formatter)
    app.logger.handlers.clear()
    app.logger.addHandler(handler)
    app.logger.setLevel(level)
    app.logger.propagate = False
