"""WSGI entry point and local development launcher."""

from __future__ import annotations

import os

from folder_visualizer import create_app


app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.getenv("FLASK_RUN_HOST", "127.0.0.1"),
        port=int(os.getenv("FLASK_RUN_PORT", "5000")),
        debug=app.debug,
    )
