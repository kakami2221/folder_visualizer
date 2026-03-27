from __future__ import annotations

from http import HTTPStatus
from importlib import resources

from flask import Flask, jsonify, render_template


app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/plotly.js")
def plotly_bundle():
    try:
        content = resources.files("plotly") / "package_data" / "plotly.min.js"
        return app.response_class(content.read_text(encoding="utf-8"), mimetype="text/javascript")
    except Exception:
        return (
            jsonify({"error": "Local Plotly bundle is unavailable. Install dependencies from requirements.txt."}),
            HTTPStatus.INTERNAL_SERVER_ERROR,
        )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
