FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FLASK_ENV=production \
    APP_VERSION=1.1.0 \
    GUNICORN_BIND=0.0.0.0:8000

WORKDIR /app

RUN groupadd --system folderviz \
    && useradd --system --gid folderviz --home-dir /app --shell /usr/sbin/nologin folderviz \
    && mkdir -p /var/log/folder-visualizer \
    && chown folderviz:folderviz /var/log/folder-visualizer

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY --chown=folderviz:folderviz . .

USER folderviz
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read()"]

CMD ["gunicorn", "--config", "gunicorn.conf.py", "app:app"]
