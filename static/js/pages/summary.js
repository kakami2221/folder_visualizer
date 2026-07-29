import {
  Storage,
  ensureAnalysis,
  formatBytes,
  formatDate,
  formatNumber,
  initializeWhenReady,
  setText,
  showMessage,
} from "./page-utils.js";

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "-";
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} 秒`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${formatNumber(minutes)} 分 ${formatNumber(seconds)} 秒`;
}

function pathAndSize(value) {
  if (!value) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  const path = String(value.relativePath || value.path || value.name || "-");
  const size = Number(value.size);
  return Number.isFinite(size) ? `${path}（${formatBytes(size)}）` : path;
}

function extensionAndMetric(value, metric) {
  if (!value) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  const extension = String(value.extension || "(拡張子なし)");
  if (metric === "count" && Number.isFinite(Number(value.count))) {
    return `${extension}（${formatNumber(value.count)} files）`;
  }
  if (metric === "size" && Number.isFinite(Number(value.size))) {
    return `${extension}（${formatBytes(value.size)}）`;
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

export function renderSummary(meta) {
  setText("summary-root", meta.rootName || "-");
  setText("total-size", formatBytes(meta.totalSize));
  setText("total-files", formatNumber(meta.totalFiles));
  setText("total-directories", formatNumber(meta.totalDirectories ?? meta.totalDirs));
  setTitledText("max-file", pathAndSize(meta.largestFile ?? meta.maxFile));
  setTitledText(
    "max-directory",
    pathAndSize(meta.largestDirectory ?? meta.maxDirectory),
  );
  setText(
    "common-extension",
    extensionAndMetric(meta.mostCommonExtension ?? meta.commonExtension, "count"),
  );
  setText("largest-extension", extensionAndMetric(meta.largestExtension, "size"));
  setText("analysis-duration", formatDuration(meta.analysisDurationMs));
  setText("storage-duration", formatDuration(meta.storageDurationMs));
  setText("analyzed-at", formatDate(meta.analyzedAt));
}

export async function initializeSummaryPage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  const meta = status.meta || await Storage.getCompleteMeta();
  if (!meta) {
    throw new Error("解析概要を読み込めませんでした。メインページで再解析してください。");
  }
  renderSummary(meta);
  showMessage("page-message", "");
}

initializeWhenReady(initializeSummaryPage);

