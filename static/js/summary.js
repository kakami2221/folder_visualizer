(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common;
  const Storage = app.Storage || app.storage;

  function pathAndSize(value) {
    if (!value) {
      return "-";
    }
    if (typeof value === "string") {
      return value;
    }
    const path = value.path || value.name || "-";
    const size = Number(value.size);
    return Number.isFinite(size) ? `${path}（${Common.formatBytes(size)}）` : path;
  }

  function extensionAndMetric(value, metric) {
    if (!value) {
      return "-";
    }
    if (typeof value === "string") {
      return value;
    }
    const extension = value.extension || "(拡張子なし)";
    if (metric === "count" && Number.isFinite(Number(value.count))) {
      return `${extension}（${Common.formatNumber(value.count)} files）`;
    }
    if (metric === "size" && Number.isFinite(Number(value.size))) {
      return `${extension}（${Common.formatBytes(value.size)}）`;
    }
    return extension;
  }

  function setTitledText(id, value) {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    element.textContent = value;
    element.title = value === "-" ? "" : value;
  }

  function render(meta) {
    Common.setText("summary-root", meta.rootName || "-");
    Common.setText("total-size", Common.formatBytes(meta.totalSize));
    Common.setText("total-files", Common.formatNumber(meta.totalFiles));
    Common.setText(
      "total-directories",
      Common.formatNumber(meta.totalDirectories ?? meta.totalDirs),
    );
    setTitledText("max-file", pathAndSize(meta.largestFile ?? meta.maxFile));
    setTitledText(
      "max-directory",
      pathAndSize(meta.largestDirectory ?? meta.maxDirectory),
    );
    Common.setText(
      "common-extension",
      extensionAndMetric(
        meta.mostCommonExtension ?? meta.commonExtension,
        "count",
      ),
    );
    Common.setText(
      "largest-extension",
      extensionAndMetric(meta.largestExtension, "size"),
    );
    Common.setText(
      "analysis-duration",
      Common.formatDuration(meta.analysisDurationMs),
    );
    Common.setText(
      "storage-duration",
      Common.formatDuration(meta.storageDurationMs),
    );
    Common.setText("analyzed-at", Common.formatDate(meta.analyzedAt));

    Common.logPerformance({
      "metadata preparation": meta.metadataDurationMs,
      "worker analysis": meta.analysisDurationMs,
      "indexedDB storage": meta.storageDurationMs,
      total: meta.totalDurationMs,
    });
  }

  function showError(error) {
    console.error("解析概要を表示できませんでした。", error);
    Common.showMessage(
      "page-message",
      error?.message || "解析概要を表示できませんでした。",
      "error",
    );
  }

  async function initialize() {
    try {
      const status = await Common.showAnalysisState();
      if (!status.available) {
        return;
      }
      const meta = status.meta || await Storage.getCompleteMeta();
      if (!meta) {
        throw new Error("解析概要を読み込めませんでした。メインページで再解析してください。");
      }
      render(meta);
    } catch (error) {
      showError(error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });

  app.SummaryPage = Object.freeze({
    render,
  });
})();
