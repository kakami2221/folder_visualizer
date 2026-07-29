(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};

  const numberFormatter = new Intl.NumberFormat("ja-JP");
  const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const TABLE_ROW_HEIGHT = 44;
  const TABLE_BUFFER_ROWS = 15;
  const TABLE_MAX_DOM_ROWS = 100;
  const CACHE_CHUNK_SIZE = 500;

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "-";
    }
    if (bytes === 0) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const exponent = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const amount = bytes / (1024 ** exponent);
    const digits = exponent === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[exponent]}`;
  }

  function formatNumber(value) {
    const number = Number(value);
    return numberFormatter.format(Number.isFinite(number) ? number : 0);
  }

  function formatDate(value) {
    if (value === null || value === undefined || value === "") {
      return "-";
    }
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? "-" : dateFormatter.format(date);
  }

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return "-";
    }
    if (milliseconds < 1000) {
      return `${Math.round(milliseconds)} ms`;
    }
    return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 1 : 2)} 秒`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function debounce(callback, delay = 250) {
    let timerId = 0;
    const debounced = (...args) => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => callback(...args), delay);
    };
    debounced.cancel = () => {
      window.clearTimeout(timerId);
      timerId = 0;
    };
    return debounced;
  }

  function showMessage(target, text = "", tone = "") {
    const element = typeof target === "string"
      ? document.getElementById(target)
      : target;
    if (!element) {
      return;
    }
    element.textContent = text;
    element.classList.remove("error", "success", "warning");
    if (tone) {
      element.classList.add(tone);
    }
  }

  function setText(target, value) {
    const element = typeof target === "string"
      ? document.getElementById(target)
      : target;
    if (element) {
      element.textContent = value ?? "-";
    }
  }

  function normalizeAnalysisStatus(status) {
    if (!status) {
      return { available: false, reason: "missing", meta: null };
    }
    const meta = status.meta || (
      status.status === "complete" || status.id === "current" ? status : null
    );
    const explicitlyUnavailable = status.available === false
      || status.usable === false;
    const available = !explicitlyUnavailable && (
      status.available === true
      || status.usable === true
      || Boolean(meta && meta.status === "complete")
    );
    return {
      ...status,
      available,
      reason: available ? null : (status.reason || status.status || "missing"),
      meta: available ? meta : null,
    };
  }

  function setAnalysisAvailability(available, root = document) {
    root
      .querySelectorAll("[data-analysis-link], [data-analysis-action]")
      .forEach((control) => {
        control.classList.toggle("is-disabled", !available);
        control.setAttribute("aria-disabled", String(!available));
        if (control.matches("button, input")) {
          control.disabled = !available;
        } else if (available) {
          control.removeAttribute("tabindex");
        } else {
          control.setAttribute("tabindex", "-1");
        }
      });
  }

  function missingAnalysisMessage(reason) {
    if (reason === "outdated" || reason === "version-mismatch") {
      return "保存済みの解析結果は古い形式です。メインページで再解析してください。";
    }
    if (reason === "processing" || reason === "saving" || reason === "writing") {
      return "解析結果の保存が完了していません。メインページで解析をやり直してください。";
    }
    if (reason === "unavailable" || reason === "indexeddb-unavailable") {
      return "このブラウザでは保存済み解析結果を利用できません。";
    }
    return "解析結果がありません。メインページでフォルダを選択し、解析を実行してください。";
  }

  async function initializeNavigation() {
    try {
      if (!app.Storage?.getAnalysisStatus) {
        setAnalysisAvailability(false);
        return { available: false, reason: "unavailable", meta: null };
      }
      const status = normalizeAnalysisStatus(await app.Storage.getAnalysisStatus());
      setAnalysisAvailability(status.available);
      return status;
    } catch (error) {
      console.error("保存済み解析結果を確認できませんでした。", error);
      setAnalysisAvailability(false);
      return { available: false, reason: "indexeddb-unavailable", meta: null, error };
    }
  }

  async function showAnalysisState() {
    const status = await initializeNavigation();
    const emptyState = document.getElementById("empty-state");
    const content = document.getElementById("analysis-content");
    const message = document.getElementById("empty-state-message");

    if (status.available) {
      emptyState?.classList.add("hidden");
      content?.classList.remove("hidden");
    } else {
      if (message) {
        message.textContent = missingAnalysisMessage(status.reason);
      }
      emptyState?.classList.remove("hidden");
      content?.classList.add("hidden");
    }
    return status;
  }

  function createMeasure(name, duration, detail = undefined) {
    if (!window.performance || !Number.isFinite(duration)) {
      return null;
    }
    try {
      performance.clearMeasures(name);
      return performance.measure(name, {
        start: 0,
        duration: Math.max(0, duration),
        detail,
      });
    } catch {
      return null;
    }
  }

  async function measureAsync(name, callback) {
    const markPrefix = `folder-visualizer:${name}:${crypto.randomUUID?.() || Date.now()}`;
    const startMark = `${markPrefix}:start`;
    const endMark = `${markPrefix}:end`;
    performance.mark(startMark);
    try {
      return await callback();
    } finally {
      performance.mark(endMark);
      performance.measure(name, startMark, endMark);
      const entries = performance.getEntriesByName(name, "measure");
      const latest = entries.at(-1);
      if (latest) {
        console.info(`Folder Visualizer Performance · ${name}: ${latest.duration.toFixed(1)} ms`);
      }
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
    }
  }

  function logPerformance(metrics) {
    const rows = Object.entries(metrics || {}).map(([name, duration]) => ({
      measure: name,
      milliseconds: Number.isFinite(Number(duration))
        ? Number(duration).toFixed(1)
        : "-",
    }));
    console.groupCollapsed("Folder Visualizer Performance");
    console.table(rows);
    console.groupEnd();
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  document.addEventListener("click", (event) => {
    const disabledLink = event.target.closest(
      "a[data-analysis-link][aria-disabled='true'], a[data-analysis-action][aria-disabled='true']",
    );
    if (disabledLink) {
      event.preventDefault();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    initializeNavigation();
  }, { once: true });

  app.Common = Object.freeze({
    TABLE_ROW_HEIGHT,
    TABLE_BUFFER_ROWS,
    TABLE_MAX_DOM_ROWS,
    CACHE_CHUNK_SIZE,
    formatBytes,
    formatNumber,
    formatDate,
    formatDuration,
    escapeHtml,
    debounce,
    showMessage,
    setText,
    normalizeAnalysisStatus,
    setAnalysisAvailability,
    missingAnalysisMessage,
    initializeNavigation,
    showAnalysisState,
    createMeasure,
    measureAsync,
    logPerformance,
    yieldToBrowser,
  });
})();
