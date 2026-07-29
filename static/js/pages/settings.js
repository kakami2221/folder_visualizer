import {
  Storage,
  byId,
  formatBytes,
  initializeWhenReady,
  setText,
  showMessage,
} from "./page-utils.js";

const DEFAULTS = Object.freeze({
  historyLimit: 5,
  autoPruneHistory: true,
  tableSize: "medium",
  searchDebounceMs: 250,
  oldFileDays: 365,
  largeFileMb: 100,
  deepPathDepth: 10,
  longPathLength: 180,
  performanceLogging: false,
});

const NUMBER_FIELDS = Object.freeze({
  historyLimit: Object.freeze({
    id: "setting-history-limit",
    minimum: 1,
    maximum: 20,
  }),
  searchDebounceMs: Object.freeze({
    id: "setting-debounce",
    minimum: 100,
    maximum: 1000,
  }),
  oldFileDays: Object.freeze({
    id: "setting-old-days",
    minimum: 30,
    maximum: 3650,
  }),
  largeFileMb: Object.freeze({
    id: "setting-large-mb",
    minimum: 1,
    maximum: 1_000_000,
  }),
  deepPathDepth: Object.freeze({
    id: "setting-deep-level",
    minimum: 2,
    maximum: 100,
  }),
  longPathLength: Object.freeze({
    id: "setting-long-path",
    minimum: 20,
    maximum: 1000,
  }),
});

function boundedInteger(id, minimum, maximum) {
  const value = Number(byId(id)?.value);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${minimum}～${maximum}の範囲で入力してください。`);
  }
  return Math.round(value);
}

function normalizeSettings(values = {}) {
  const normalized = { ...DEFAULTS };
  Object.entries(NUMBER_FIELDS).forEach(([key, definition]) => {
    const value = Number(values[key]);
    if (Number.isFinite(value)) {
      normalized[key] = Math.max(
        definition.minimum,
        Math.min(definition.maximum, Math.round(value)),
      );
    }
  });
  normalized.autoPruneHistory = values.autoPruneHistory === undefined
    ? DEFAULTS.autoPruneHistory
    : Boolean(values.autoPruneHistory);
  normalized.performanceLogging = Boolean(values.performanceLogging);
  normalized.tableSize = ["small", "medium", "large"].includes(values.tableSize)
    ? values.tableSize
    : DEFAULTS.tableSize;
  return normalized;
}

function readForm() {
  const values = {};
  Object.entries(NUMBER_FIELDS).forEach(([key, definition]) => {
    values[key] = boundedInteger(
      definition.id,
      definition.minimum,
      definition.maximum,
    );
  });
  values.autoPruneHistory = Boolean(byId("setting-auto-prune")?.checked);
  values.performanceLogging = Boolean(byId("setting-performance-log")?.checked);
  values.tableSize = String(byId("setting-table-size")?.value || "");
  if (!["small", "medium", "large"].includes(values.tableSize)) {
    throw new Error("ファイルテーブルの高さを選択してください。");
  }
  return values;
}

function writeForm(values) {
  const normalized = normalizeSettings(values);
  Object.entries(NUMBER_FIELDS).forEach(([key, definition]) => {
    const element = byId(definition.id);
    if (element) {
      element.value = String(normalized[key]);
    }
  });
  byId("setting-auto-prune").checked = normalized.autoPruneHistory;
  byId("setting-performance-log").checked = normalized.performanceLogging;
  byId("setting-table-size").value = normalized.tableSize;
}

async function updateStorageEstimate() {
  if (!navigator.storage?.estimate) {
    setText("storage-usage", "このブラウザでは確認できません");
    setText("storage-quota", "このブラウザでは確認できません");
    setText("storage-ratio", "-");
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    const usage = Number(estimate.usage);
    const quota = Number(estimate.quota);
    setText("storage-usage", Number.isFinite(usage) ? formatBytes(usage) : "不明");
    setText("storage-quota", Number.isFinite(quota) ? formatBytes(quota) : "不明");
    setText(
      "storage-ratio",
      Number.isFinite(usage) && Number.isFinite(quota) && quota > 0
        ? `${(usage / quota * 100).toFixed(2)}%`
        : "不明",
    );
  } catch {
    setText("storage-usage", "取得できませんでした");
    setText("storage-quota", "取得できませんでした");
    setText("storage-ratio", "-");
  }
}

async function saveCurrentSettings() {
  const values = readForm();
  await Storage.saveSettings(values);
  window.FolderVisualizer = window.FolderVisualizer || {};
  window.FolderVisualizer.performanceLogging = values.performanceLogging;
  showMessage("page-message", "設定をこのブラウザへ保存しました。", "success");
}

async function resetSettings() {
  if (!window.confirm("このページの設定を既定値へ戻しますか？")) {
    return;
  }
  await Storage.saveSettings(DEFAULTS);
  writeForm(DEFAULTS);
  window.FolderVisualizer = window.FolderVisualizer || {};
  window.FolderVisualizer.performanceLogging = DEFAULTS.performanceLogging;
  showMessage("page-message", "設定を既定値へ戻しました。", "success");
}

async function clearCurrentAnalysis() {
  const status = await Storage.getAnalysisStatus();
  if (!status.meta) {
    showMessage("page-message", "削除する現在の解析結果はありません。", "warning");
    return;
  }
  if (!window.confirm(
    "現在の解析結果をこのブラウザから削除します。解析履歴と保存済み検索は残ります。続行しますか？",
  )) {
    return;
  }
  const cleared = await Storage.clearAnalysis(status.meta.analysisId);
  if (!cleared) {
    throw new Error("解析結果が更新されたため削除しませんでした。ページを再読み込みしてください。");
  }
  await updateStorageEstimate();
  await window.FolderVisualizer?.BasePage?.refreshStatus?.();
  showMessage("page-message", "現在の解析結果を削除しました。", "success");
}

function guarded(action, fallbackMessage) {
  return () => {
    void action().catch((error) => {
      showMessage("page-message", error?.message || fallbackMessage, "error");
    });
  };
}

function bindEvents() {
  byId("settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    guarded(saveCurrentSettings, "設定を保存できませんでした。")();
  });
  byId("reset-settings")?.addEventListener(
    "click",
    guarded(resetSettings, "設定を既定値へ戻せませんでした。"),
  );
  byId("clear-current-analysis")?.addEventListener(
    "click",
    guarded(clearCurrentAnalysis, "現在の解析結果を削除できませんでした。"),
  );
}

async function initialize() {
  const settings = await Storage.getSettings();
  writeForm(settings);
  bindEvents();
  await updateStorageEstimate();
}

initializeWhenReady(initialize);

export { DEFAULTS, normalizeSettings };
