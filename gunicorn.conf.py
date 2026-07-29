"""Gunicorn production configuration.

All request logging intentionally omits the query string so browser-local
search filters or other local metadata cannot be written to server logs.
"""

from __future__ import annotations

import os


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def env_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


bind = os.getenv("GUNICORN_BIND", "127.0.0.1:8000")
workers = env_int("GUNICORN_WORKERS", 2, 1, 8)
threads = env_int("GUNICORN_THREADS", 4, 1, 16)
worker_class = "gthread"
timeout = env_int("GUNICORN_TIMEOUT", 30, 5, 300)
graceful_timeout = env_int("GUNICORN_GRACEFUL_TIMEOUT", 30, 5, 300)

accesslog = os.getenv(
    "GUNICORN_ACCESS_LOG",
    "/var/log/folder-visualizer/gunicorn-access.log",
)
errorlog = os.getenv(
    "GUNICORN_ERROR_LOG",
    "/var/log/folder-visualizer/gunicorn-error.log",
)
loglevel = os.getenv("LOG_LEVEL", "info").lower()
capture_output = True

# Request targets are intentionally omitted. This prevents arbitrary 404 paths
# and query strings from becoming a side channel for local metadata.
access_log_format = (
    "%(a)s %(m)s %(s)s %(b)s %(L)s %(p)s"
)

max_requests = env_int("GUNICORN_MAX_REQUESTS", 1000, 0, 100_000)
max_requests_jitter = env_int(
    "GUNICORN_MAX_REQUESTS_JITTER",
    100,
    0,
    10_000,
)
preload_app = env_bool("GUNICORN_PRELOAD", False)
keepalive = env_int("GUNICORN_KEEPALIVE", 5, 1, 60)
forwarded_allow_ips = os.getenv("GUNICORN_FORWARDED_ALLOW_IPS", "127.0.0.1")

worker_tmp_dir = "/dev/shm"
