import Storage from "../storage/index.js";

const numberFormatter = new Intl.NumberFormat("ja-JP");
const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export { Storage };

export function formatBytes(value) {
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

export function formatNumber(value) {
  const number = Number(value);
  return numberFormatter.format(Number.isFinite(number) ? number : 0);
}

export function formatDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "-";
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "-" : dateFormatter.format(date);
}

export function formatSignedNumber(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? "+" : ""}${formatNumber(number)}`;
}

export function formatSignedBytes(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? "+" : number < 0 ? "−" : ""}${formatBytes(Math.abs(number))}`;
}

export function byId(id) {
  return document.getElementById(id);
}

export function setText(idOrElement, value) {
  const element = typeof idOrElement === "string" ? byId(idOrElement) : idOrElement;
  if (element) {
    element.textContent = value ?? "";
  }
}

export function showMessage(idOrElement, message = "", tone = "") {
  const element = typeof idOrElement === "string" ? byId(idOrElement) : idOrElement;
  if (!element) {
    return;
  }
  element.textContent = message;
  element.classList.remove("error", "success", "warning");
  if (tone) {
    element.classList.add(tone);
  }
}

export function createElement(tagName, options = {}, children = []) {
  const element = document.createElement(tagName);
  if (options.className) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = String(options.text);
  }
  if (options.title) {
    element.title = String(options.title);
  }
  if (options.type) {
    element.type = options.type;
  }
  if (options.value !== undefined) {
    element.value = String(options.value);
  }
  if (options.href) {
    element.href = String(options.href);
  }
  if (options.download) {
    element.download = String(options.download);
  }
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      element.dataset[key] = String(value);
    });
  }
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([name, value]) => {
      element.setAttribute(name, String(value));
    });
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child instanceof Node) {
      element.appendChild(child);
    } else if (child !== null && child !== undefined) {
      element.appendChild(document.createTextNode(String(child)));
    }
  }
  return element;
}

export async function ensureAnalysis(options = {}) {
  try {
    const status = await Storage.getAnalysisStatus();
    const available = Boolean(status.available || status.usable);
    const emptyState = byId(options.emptyStateId || "empty-state");
    const content = byId(options.contentId || "analysis-content");
    if (emptyState) {
      emptyState.classList.toggle("hidden", available);
    }
    if (content) {
      content.classList.toggle("hidden", !available);
    }
    if (!available) {
      const reason = status.reason === "outdated"
        ? "保存済みの解析結果は古い形式です。メインページで再解析してください。"
        : status.reason === "indexeddb-unavailable"
          ? "このブラウザでは保存済み解析結果を利用できません。"
          : "解析結果がありません。メインページでフォルダを選択し、解析を実行してください。";
      setText("empty-state-message", reason);
    }
    return status;
  } catch (error) {
    const emptyState = byId(options.emptyStateId || "empty-state");
    const content = byId(options.contentId || "analysis-content");
    emptyState?.classList.remove("hidden");
    content?.classList.add("hidden");
    setText("empty-state-message", "保存済み解析結果を読み込めませんでした。ブラウザの保存領域を確認してください。");
    throw error;
  }
}

export function debounce(callback, delay = 250) {
  let timer = 0;
  const debounced = (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
  debounced.cancel = () => window.clearTimeout(timer);
  return debounced;
}

export function sanitizeFileName(value, fallback = "folder-visualizer") {
  const normalized = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/gu, "")
    .slice(0, 100);
  return normalized || fallback;
}

export function downloadBlob(content, fileName, type = "application/octet-stream") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeFileName(fileName, "folder-visualizer-export");
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("このブラウザではクリップボードへコピーできません。");
  }
  await navigator.clipboard.writeText(String(text));
}

export function safeCsvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/u.test(text)) {
    text = `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function rowsToCsv(headers, rows) {
  const lines = [
    headers.map((header) => safeCsvCell(header)).join(","),
    ...rows.map((row) => row.map((cell) => safeCsvCell(cell)).join(",")),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_[\]{}()#+\-.!|>]/gu, "\\$&");
}

export function escapeMermaid(value) {
  return String(value)
    .replace(/["<>[\]{}()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseDateStart(value) {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function parseDateEnd(value) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = new Date(`${value}T23:59:59.999`).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function queryFromUrl(search = window.location.search) {
  const params = new URLSearchParams(search);
  const criteria = {};
  const textFields = {
    name: "name",
    path: "path",
    extension: "extension",
    category: "category",
    directory: "directory",
    age: "ageBucket",
    sort: "sortBy",
    direction: "direction",
  };
  Object.entries(textFields).forEach(([parameter, key]) => {
    const value = params.get(parameter);
    if (value && value.length <= 500) {
      criteria[key] = value;
    }
  });
  for (const [parameter, key] of [["minSize", "minSize"], ["maxSize", "maxSize"]]) {
    const raw = params.get(parameter);
    if (raw === null || raw.trim() === "") {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
      criteria[key] = value;
    }
  }
  for (const [parameter, key] of [["updatedFrom", "updatedFrom"], ["updatedTo", "updatedTo"]]) {
    const raw = params.get(parameter);
    const value = /^\d+$/u.test(raw || "") ? Number(raw) : NaN;
    if (Number.isFinite(value) && value >= 0) {
      criteria[key] = value;
    }
  }
  if (params.get("regex") === "1") {
    criteria.useRegex = true;
  }
  return criteria;
}

export function buildMainUrl(criteria = {}) {
  const params = new URLSearchParams();
  const allowedText = {
    name: "name",
    path: "path",
    extension: "extension",
    category: "category",
    directory: "directory",
    ageBucket: "age",
    sortBy: "sort",
    direction: "direction",
  };
  Object.entries(allowedText).forEach(([key, parameter]) => {
    const value = String(criteria[key] || "").trim();
    if (value && value.length <= 500) {
      params.set(parameter, value);
    }
  });
  for (const [key, parameter] of [["minSize", "minSize"], ["maxSize", "maxSize"], ["updatedFrom", "updatedFrom"], ["updatedTo", "updatedTo"]]) {
    const value = Number(criteria[key]);
    if (Number.isFinite(value) && value >= 0) {
      params.set(parameter, String(Math.floor(value)));
    }
  }
  if (criteria.useRegex) {
    params.set("regex", "1");
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export async function readAllCurrentFiles(options = {}) {
  const chunkSize = Math.max(100, Math.min(5000, Number(options.chunkSize) || 1000));
  const result = await Storage.queryFileIds(options.criteria || {}, {
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
  });
  if (result.cancelled) {
    return [];
  }
  const files = [];
  for (let start = 0; start < result.ids.length; start += chunkSize) {
    if (options.isCancelled?.()) {
      const error = new Error("処理をキャンセルしました。");
      error.name = "AbortError";
      throw error;
    }
    const rows = await Storage.getFilesByIds(result.ids.slice(start, start + chunkSize));
    files.push(...rows);
    options.onChunk?.(rows, start, result.ids.length);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return files;
}

export async function forEachCurrentFile(callback, options = {}) {
  const chunkSize = Math.max(100, Math.min(5000, Number(options.chunkSize) || 1000));
  const result = await Storage.queryFileIds(options.criteria || {}, {
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
  });
  if (result.cancelled) {
    return { count: 0, cancelled: true };
  }
  for (let start = 0; start < result.ids.length; start += chunkSize) {
    if (options.isCancelled?.()) {
      return { count: start, cancelled: true };
    }
    const rows = await Storage.getFilesByIds(result.ids.slice(start, start + chunkSize));
    await callback(rows, start, result.ids.length);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return { count: result.ids.length, cancelled: false };
}

export async function measured(name, callback) {
  const token = `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const start = `${token}:start`;
  const end = `${token}:end`;
  const startedAt = performance.now();
  performance.mark(start);
  try {
    return await callback();
  } finally {
    performance.mark(end);
    try {
      performance.measure(name, start, end);
      if (globalThis.FolderVisualizer?.performanceLogging) {
        const duration = Math.max(0, performance.now() - startedAt);
        console.info(
          `[Folder Visualizer] ${String(name)}: ${duration.toFixed(1)} ms`,
        );
      }
    } finally {
      performance.clearMarks(start);
      performance.clearMarks(end);
    }
  }
}

export async function requirePlotly() {
  if (window.Plotly?.react) {
    return window.Plotly;
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 25));
    if (window.Plotly?.react) {
      return window.Plotly;
    }
  }
  throw new Error("Plotly.jsを読み込めませんでした。ページを再読み込みしてください。");
}

export function initializeWhenReady(callback) {
  const run = () => Promise.resolve(callback()).catch((error) => {
    console.error("ページを初期化できませんでした。", error);
    showMessage("page-message", error?.message || "ページを初期化できませんでした。", "error");
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    void run();
  }
}
