import {
  compareSources,
  cancelComparison,
} from "../analysis/compare-controller.js";
import { ClientVirtualList } from "../table/client-virtual-list.js";
import {
  Storage,
  buildMainUrl,
  byId,
  createElement,
  downloadBlob,
  formatBytes,
  formatNumber,
  formatSignedBytes,
  formatSignedNumber,
  initializeWhenReady,
  measured,
  requirePlotly,
  rowsToCsv,
  setText,
  showMessage,
} from "./page-utils.js";

const CATEGORY_EXTENSIONS = Object.freeze({
  "source-code": new Set([".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".rb", ".php", ".swift", ".kt", ".cs", ".vue", ".svelte", ".html", ".css", ".scss", ".sh"]),
  document: new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".rtf"]),
  image: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".ico"]),
  video: new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv"]),
  audio: new Set([".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"]),
  archive: new Set([".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"]),
  data: new Set([".json", ".xml", ".yaml", ".yml", ".csv", ".tsv", ".sql", ".db", ".sqlite"]),
});

const STATUS_LABELS = Object.freeze({
  "only-a": "Aにのみ存在",
  "only-b": "Bにのみ存在",
  "likely-same": "同一の可能性が高い",
  "size-changed": "サイズが異なる",
  "date-changed": "更新日時が異なる",
});

const state = {
  mode: "folders",
  histories: [],
  results: [],
  filtered: [],
  summary: null,
  list: null,
  token: 0,
  busy: false,
  sourceNames: { a: "A", b: "B" },
};

function extensionOf(name) {
  const lower = String(name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 && dot < lower.length - 1 ? lower.slice(dot) : "(no extension)";
}

function categoryOf(extension) {
  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (extensions.has(extension)) {
      return category;
    }
  }
  return "other";
}

function rootAndRelativePath(fileList) {
  const raw = String(fileList?.[0]?.webkitRelativePath || "").replaceAll("\\", "/");
  const root = raw.split("/").filter(Boolean)[0] || "Selected Folder";
  return { root };
}

async function metadataFromFileList(fileList, label, onProgress, isCancelled) {
  const rows = [];
  const total = Number(fileList?.length) || 0;
  const { root } = rootAndRelativePath(fileList);
  for (let start = 0; start < total; start += 2000) {
    if (isCancelled()) {
      const error = new Error("比較処理をキャンセルしました。");
      error.name = "AbortError";
      throw error;
    }
    const end = Math.min(total, start + 2000);
    for (let index = start; index < end; index += 1) {
      const file = fileList[index];
      const parts = String(file.webkitRelativePath || file.name || "")
        .replaceAll("\\", "/")
        .split("/")
        .filter(Boolean);
      const relativeParts = parts[0] === root ? parts.slice(1) : parts;
      const relativePath = relativeParts.join("/") || String(file.name || "");
      const extension = extensionOf(file.name);
      rows.push({
        id: index,
        name: String(file.name || ""),
        relativePath,
        relativePathLower: relativePath.toLowerCase(),
        extension,
        category: categoryOf(extension),
        size: Math.max(0, Number(file.size) || 0),
        lastModified: Math.max(0, Number(file.lastModified) || 0),
      });
    }
    onProgress(`${label}のメタデータを準備中: ${formatNumber(end)} / ${formatNumber(total)}`);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return { root, rows };
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll(
    "#folder-compare-form input, #folder-compare-form button, #history-compare-form select, #history-compare-form button",
  ).forEach((control) => {
    control.disabled = value;
  });
  byId("cancel-comparison")?.classList.toggle("hidden", !value);
}

function statusMatches(row, filter) {
  if (!filter) {
    return true;
  }
  if (filter === "same") {
    return row.status === "likely-same";
  }
  if (filter === "changed") {
    return row.status === "size-changed" || row.status === "date-changed";
  }
  return row.status === filter;
}

function renderResultRow(row) {
  const relativePath = row.relativePath || row.a?.relativePath || row.b?.relativePath || "";
  const pathLink = createElement("a", {
    className: "truncate mono",
    text: relativePath,
    title: relativePath,
    href: buildMainUrl({ path: relativePath }),
  });
  return createElement("div", {
    className: "compare-row",
    attributes: { role: "row" },
  }, [
    createElement("span", {
      className: row.status.includes("changed") ? "tag tag-warning" : "tag",
      text: STATUS_LABELS[row.status] || row.status,
    }),
    pathLink,
    createElement("span", { text: row.a ? formatBytes(row.a.size) : "-" }),
    createElement("span", { text: row.b ? formatBytes(row.b.size) : "-" }),
    createElement("span", {
      text: row.status === "date-changed"
        ? "更新日時差"
        : formatSignedBytes(row.sizeDelta),
    }),
  ]);
}

function applyResultFilter() {
  const filter = String(byId("compare-filter")?.value || "");
  state.filtered = state.results.filter((row) => statusMatches(row, filter));
  state.list.setItems(state.filtered);
}

function directoryDeltas(results) {
  const map = new Map();
  results.forEach((row) => {
    const parts = String(row.relativePath || "").split("/").filter(Boolean);
    parts.pop();
    const delta = Number(row.b?.size || 0) - Number(row.a?.size || 0);
    let current = "";
    parts.forEach((part) => {
      current = current ? `${current}/${part}` : part;
      map.set(current, (map.get(current) || 0) + delta);
    });
  });
  return [...map.entries()]
    .map(([label, delta]) => ({ label, delta }))
    .filter((row) => row.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 12);
}

function renderDeltaList(id, rows, labelKey) {
  const target = byId(id);
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  rows
    .filter((row) => Number(row.delta) !== 0)
    .sort((left, right) => Math.abs(Number(right.delta)) - Math.abs(Number(left.delta)))
    .slice(0, 12)
    .forEach((row) => {
      const label = row[labelKey] || row.label || "(なし)";
      fragment.appendChild(createElement("li", {}, [
        createElement("span", { text: label, title: label }),
        createElement("strong", { text: formatSignedBytes(row.delta) }),
      ]));
    });
  if (!fragment.childNodes.length) {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: "差分なし" }),
      createElement("strong", { text: "0 B" }),
    ]));
  }
  target.replaceChildren(fragment);
}

async function drawChart(summary) {
  const Plotly = await requirePlotly();
  const counts = summary.statusCounts || {};
  const labels = ["Aのみ", "Bのみ", "同一可能性", "サイズ差", "更新日時差"];
  const values = [
    counts["only-a"] || 0,
    counts["only-b"] || 0,
    counts["likely-same"] || 0,
    counts["size-changed"] || 0,
    counts["date-changed"] || 0,
  ];
  await Plotly.react("compare-chart", [{
    type: "bar",
    x: labels,
    y: values,
    marker: { color: ["#245852", "#bf5f2d", "#6c9b89", "#d98650", "#9b6c4d"] },
    hovertemplate: "%{x}: %{y:,}件<extra></extra>",
  }], {
    margin: { t: 20, r: 20, b: 60, l: 70 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    yaxis: { title: "ファイル数" },
  }, { responsive: true, displayModeBar: false });
}

async function persistResults(rows) {
  await Storage.clearComparisonResults();
  for (let start = 0; start < rows.length; start += 1000) {
    await Storage.saveComparisonResults(rows.slice(start, start + 1000));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

async function displayComparison(result) {
  state.summary = result.summary;
  state.results = result.results || [];
  const counts = state.summary.statusCounts || {};
  const changed = (counts["size-changed"] || 0) + (counts["date-changed"] || 0);
  const both = changed + (counts["likely-same"] || 0);
  setText("compare-only-a", formatNumber(counts["only-a"] || 0));
  setText("compare-only-b", formatNumber(counts["only-b"] || 0));
  setText("compare-both", formatNumber(both));
  setText("compare-changed", formatNumber(changed));
  setText("compare-count-delta", formatSignedNumber(
    Number(state.summary.countB) - Number(state.summary.countA),
  ));
  setText("compare-size-delta", formatSignedBytes(state.summary.sizeDelta));
  renderDeltaList("compare-directory-delta", directoryDeltas(state.results), "label");
  renderDeltaList("compare-extension-delta", state.summary.extensionDelta || [], "extension");
  renderDeltaList("compare-category-delta", state.summary.categoryDelta || [], "category");
  byId("comparison-content")?.classList.remove("hidden");
  applyResultFilter();
  await Promise.all([
    drawChart(state.summary),
    persistResults(state.results),
  ]);
}

async function executeComparison(rowsA, rowsB, sourceNames) {
  const token = ++state.token;
  state.sourceNames = sourceNames;
  setBusy(true);
  showMessage("compare-progress", "比較用Workerを準備しています。");
  performance.mark(`folder-compare:${token}:start`);
  try {
    const result = await measured("folder comparison", () => compareSources(rowsA, rowsB, {
      comparisonId: crypto.randomUUID?.() || `comparison-${Date.now()}`,
      onProgress: ({ processed, total }) => {
        if (token === state.token) {
          showMessage(
            "compare-progress",
            `比較中: ${formatNumber(processed)} / ${formatNumber(total)}`,
          );
        }
      },
    }));
    if (token !== state.token) {
      return;
    }
    await displayComparison(result);
    showMessage(
      "compare-progress",
      `${sourceNames.a}と${sourceNames.b}の比較が完了しました。`,
      "success",
    );
  } finally {
    if (token === state.token) {
      setBusy(false);
    }
  }
}

async function compareFolders() {
  const filesA = byId("compare-folder-a")?.files;
  const filesB = byId("compare-folder-b")?.files;
  if (!filesA?.length || !filesB?.length) {
    throw new Error("比較するフォルダAとフォルダBを両方選択してください。");
  }
  const token = ++state.token;
  setBusy(true);
  try {
    const isCancelled = () => token !== state.token;
    const onProgress = (message) => showMessage("compare-progress", message);
    const preparedA = await metadataFromFileList(filesA, "フォルダA", onProgress, isCancelled);
    const preparedB = await metadataFromFileList(filesB, "フォルダB", onProgress, isCancelled);
    if (isCancelled()) {
      return;
    }
    state.token -= 1;
    await executeComparison(preparedA.rows, preparedB.rows, {
      a: preparedA.root,
      b: preparedB.root,
    });
  } finally {
    if (token === state.token) {
      setBusy(false);
    }
  }
}

async function compareHistories() {
  const idA = String(byId("compare-history-a")?.value || "");
  const idB = String(byId("compare-history-b")?.value || "");
  if (!idA || !idB || idA === idB) {
    throw new Error("異なる保存済み解析を2件選択してください。");
  }
  const historyA = state.histories.find((item) => String(item.analysisId) === idA);
  const historyB = state.histories.find((item) => String(item.analysisId) === idB);
  showMessage("compare-progress", "保存済み解析を読み込んでいます。");
  const [rowsA, rowsB] = await Promise.all([
    Storage.getHistoryFiles(idA),
    Storage.getHistoryFiles(idB),
  ]);
  await executeComparison(rowsA, rowsB, {
    a: historyA?.rootName || "解析A",
    b: historyB?.rootName || "解析B",
  });
}

function setMode(mode) {
  state.mode = mode === "history" ? "history" : "folders";
  byId("folder-compare-form")?.classList.toggle("hidden", state.mode !== "folders");
  byId("history-compare-form")?.classList.toggle("hidden", state.mode !== "history");
  document.querySelectorAll("[data-compare-mode]").forEach((button) => {
    const active = button.dataset.compareMode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function populateHistorySelectors() {
  for (const id of ["compare-history-a", "compare-history-b"]) {
    const select = byId(id);
    if (!select) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    state.histories.forEach((history) => {
      const option = createElement("option", {
        value: history.analysisId,
        text: `${history.rootName || "解析"}・${new Date(history.analyzedAt).toLocaleString("ja-JP")}`,
      });
      fragment.appendChild(option);
    });
    select.replaceChildren(fragment);
  }
  if (state.histories.length > 1) {
    byId("compare-history-b").selectedIndex = 1;
  }
}

function exportResults(format) {
  if (!state.results.length) {
    throw new Error("先にフォルダ比較を実行してください。");
  }
  const baseName = `folder-comparison-${Date.now()}`;
  if (format === "json") {
    downloadBlob(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        sources: state.sourceNames,
        summary: state.summary,
        results: state.filtered,
      }, null, 2),
      `${baseName}.json`,
      "application/json;charset=utf-8",
    );
    return;
  }
  const csv = rowsToCsv(
    ["状態", "相対パス", "Aサイズ", "Bサイズ", "サイズ差", "A更新日時", "B更新日時"],
    state.filtered.map((row) => [
      STATUS_LABELS[row.status] || row.status,
      row.relativePath,
      row.a?.size ?? "",
      row.b?.size ?? "",
      row.sizeDelta,
      row.a?.lastModified ?? "",
      row.b?.lastModified ?? "",
    ]),
  );
  downloadBlob(csv, `${baseName}.csv`, "text/csv;charset=utf-8");
}

function bindEvents() {
  document.querySelectorAll("[data-compare-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.compareMode));
  });
  byId("folder-compare-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void compareFolders().catch((error) => {
      showMessage(
        "compare-progress",
        error?.name === "AbortError" ? "比較をキャンセルしました。" : error.message,
        error?.name === "AbortError" ? "warning" : "error",
      );
      setBusy(false);
    });
  });
  byId("history-compare-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void compareHistories().catch((error) => {
      showMessage("compare-progress", error.message, "error");
      setBusy(false);
    });
  });
  byId("cancel-comparison")?.addEventListener("click", () => {
    state.token += 1;
    void cancelComparison();
    setBusy(false);
    showMessage("compare-progress", "比較をキャンセルしました。", "warning");
  });
  byId("compare-filter")?.addEventListener("change", applyResultFilter);
  byId("export-compare-csv")?.addEventListener("click", () => {
    try {
      exportResults("csv");
    } catch (error) {
      showMessage("page-message", error.message, "error");
    }
  });
  byId("export-compare-json")?.addEventListener("click", () => {
    try {
      exportResults("json");
    } catch (error) {
      showMessage("page-message", error.message, "error");
    }
  });
}

async function initialize() {
  state.list = new ClientVirtualList({
    viewport: "compare-list-viewport",
    spacer: "compare-list-spacer",
    rows: "compare-list-rows",
    rowHeight: 64,
    renderRow: renderResultRow,
  });
  state.histories = await Storage.listHistory();
  populateHistorySelectors();
  bindEvents();
  setMode("folders");
}

initializeWhenReady(initialize);

export { categoryOf, extensionOf, metadataFromFileList, statusMatches };
