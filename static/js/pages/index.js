import Analyzer from "../analysis/analyzer.js";
import Storage from "../storage/index.js";
import {
  byId,
  buildMainUrl,
  createElement,
  debounce,
  formatBytes,
  formatDate,
  formatNumber,
  initializeWhenReady,
  measured,
  parseDateEnd,
  parseDateStart,
  queryFromUrl,
  setText,
  showMessage,
} from "./page-utils.js";

const MEGABYTE = 1024 * 1024;
const MAIN_VIEWS = Object.freeze(["overview", "files", "analysis"]);
const CATEGORY_LABELS = Object.freeze({
  "source-code": "ソースコード",
  document: "文書",
  image: "画像",
  video: "動画",
  audio: "音声",
  archive: "圧縮ファイル",
  data: "データ",
  executable: "実行ファイル",
  font: "フォント",
  temporary: "一時ファイル",
  log: "ログ",
  backup: "バックアップ",
  "no-extension": "拡張子なし",
  other: "その他",
});
const CHART_COLORS = Object.freeze([
  "#3b6fd8",
  "#14768c",
  "#6b5bd2",
  "#25a0b5",
  "#4f86e8",
  "#7c91b7",
  "#38a07c",
  "#5572a8",
  "#8a70c7",
  "#4a9aac",
  "#7994d8",
  "#456477",
  "#9aa9bd",
  "#5e8498",
]);
const state = {
  table: null,
  ready: false,
  busy: false,
  formOpen: true,
  eventsBound: false,
  analysisToken: 0,
  queryToken: 0,
  startedAt: 0,
  elapsedTimer: 0,
  status: null,
  settings: null,
  currentView: "overview",
  tableLoaded: false,
  loadedAnalysisId: null,
  currentAnalysisId: null,
  chartMetric: "size",
  chartRows: [],
  chartRenderToken: 0,
  plotlyPromise: null,
};

function setMainView(requestedView, options = {}) {
  const requested = MAIN_VIEWS.includes(requestedView) ? requestedView : "overview";
  const view = requested === "files" && (!state.status?.available || !state.table)
    ? "overview"
    : requested;
  state.currentView = view;

  document.querySelectorAll("[data-main-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.mainPanel !== view);
  });
  document.querySelectorAll("[data-main-view]").forEach((button) => {
    const active = button.dataset.mainView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.setAttribute("tabindex", active ? "0" : "-1");
  });

  if (view === "files") {
    purgeMainChart();
    window.requestAnimationFrame(() => state.table?.scheduleRender?.(true));
  } else if (view === "analysis") {
    purgeMainChart();
  } else if (options.renderChart !== false) {
    window.requestAnimationFrame(() => void renderMainChart());
  }
  if (options.focusPanel) {
    const panelIds = {
      overview: "overview-panel",
      files: "file-panel",
      analysis: "analysis-actions",
    };
    byId(panelIds[view])?.focus({ preventScroll: true });
  }
}

function dashboardIsVisible() {
  const dashboard = byId("post-analysis-view");
  return Boolean(dashboard && !dashboard.classList.contains("hidden"));
}

function syncPrimaryLayout(options = {}) {
  const available = Boolean(state.status?.available && state.status?.meta);
  const showDashboard = available && state.ready && !state.formOpen && !state.busy;
  byId("pre-analysis-view")?.classList.toggle("hidden", showDashboard);
  byId("post-analysis-view")?.classList.toggle("hidden", !showDashboard);
  byId("saved-analysis-actions")?.classList.toggle("hidden", !available);

  if (!showDashboard || state.currentView !== "overview") {
    purgeMainChart();
    return;
  }
  if (options.renderChart !== false) {
    window.requestAnimationFrame(() => void renderMainChart());
  }
}

function openAnalysisForm() {
  if (state.busy) {
    return;
  }
  state.formOpen = true;
  syncPrimaryLayout();
  window.requestAnimationFrame(() => byId("folder-input")?.focus());
}

function returnToDashboard() {
  if (!state.status?.available) {
    return;
  }
  state.formOpen = false;
  setMainView("overview", { renderChart: false });
  syncPrimaryLayout();
}

function setReady(value) {
  state.ready = Boolean(value);
  const analyze = byId("analyze-button");
  if (!analyze) {
    return;
  }
  analyze.disabled = !state.ready || state.busy;
  analyze.textContent = state.busy
    ? "解析中..."
    : state.ready ? "フォルダを解析" : "準備中...";
}

function categoryRows(meta, extensions = []) {
  const fromMeta = Array.isArray(meta?.categoryStats)
    ? meta.categoryStats
      .map((row) => ({
        category: String(row?.category || "other"),
        size: Math.max(0, Number(row?.size) || 0),
        count: Math.max(0, Number(row?.count) || 0),
      }))
      .filter((row) => row.size > 0 || row.count > 0)
    : [];
  if (fromMeta.length) {
    return fromMeta.sort((left, right) => right.size - left.size);
  }

  const aggregate = new Map();
  extensions.forEach((row) => {
    const category = String(row?.category || "other");
    const current = aggregate.get(category) || { category, size: 0, count: 0 };
    current.size += Math.max(0, Number(row?.size) || 0);
    current.count += Math.max(0, Number(row?.count) || 0);
    aggregate.set(category, current);
  });
  return [...aggregate.values()]
    .filter((row) => row.size > 0 || row.count > 0)
    .sort((left, right) => right.size - left.size);
}

function loadPlotly() {
  if (window.Plotly?.react) {
    return Promise.resolve(window.Plotly);
  }
  if (state.plotlyPromise) {
    return state.plotlyPromise;
  }
  state.plotlyPromise = new Promise((resolve, reject) => {
    const source = byId("post-analysis-view")?.dataset.plotlyUrl;
    if (!source) {
      reject(new Error("チャートライブラリのURLが設定されていません。"));
      return;
    }
    const url = new URL(source, window.location.href);
    if (url.origin !== window.location.origin) {
      reject(new Error("チャートライブラリは同一サイトからのみ読み込めます。"));
      return;
    }
    const script = document.createElement("script");
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      script.remove();
      reject(new Error("チャートの読み込みがタイムアウトしました。"));
    }, 15000);
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      callback();
    };
    script.src = url.href;
    script.async = true;
    script.dataset.mainPlotly = "true";
    script.addEventListener("load", () => finish(() => {
      if (window.Plotly?.react) {
        resolve(window.Plotly);
      } else {
        reject(new Error("チャートライブラリを初期化できませんでした。"));
      }
    }), { once: true });
    script.addEventListener("error", () => finish(() => {
      reject(new Error("チャートライブラリを読み込めませんでした。"));
    }), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    state.plotlyPromise = null;
    throw error;
  });
  return state.plotlyPromise;
}

function purgeMainChart() {
  state.chartRenderToken += 1;
  const chart = byId("main-category-chart");
  if (!chart) {
    return;
  }
  chart.removeAllListeners?.("plotly_click");
  if (window.Plotly?.purge && chart.childElementCount) {
    window.Plotly.purge(chart);
  }
  chart.classList.add("hidden");
}

function waitForChartTurn() {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(resolve, { timeout: 600 });
      return;
    }
    window.requestAnimationFrame(() => resolve());
  });
}

async function renderMainChart() {
  if (
    !state.status?.available
    || state.currentView !== "overview"
    || !dashboardIsVisible()
  ) {
    return;
  }
  const chart = byId("main-category-chart");
  const status = byId("main-chart-status");
  if (!chart || !status) {
    return;
  }
  const metric = state.chartMetric === "count" ? "count" : "size";
  const rows = state.chartRows
    .filter((row) => Number(row[metric]) > 0)
    .sort((left, right) => Number(right[metric]) - Number(left[metric]));
  const token = ++state.chartRenderToken;
  const analysisId = state.currentAnalysisId;
  chart.classList.add("hidden");
  status.classList.remove("hidden", "error");
  if (!rows.length) {
    status.textContent = "表示できる分類データがありません。下の表で詳細を確認できます。";
    return;
  }
  chart.classList.remove("hidden");
  status.textContent = "Interactive chart を読み込んでいます...";

  try {
    // Let the result dashboard paint before parsing the comparatively large
    // Plotly bundle, so the completed analysis never looks frozen.
    await waitForChartTurn();
    if (token !== state.chartRenderToken || !dashboardIsVisible()) {
      return;
    }
    const Plotly = await loadPlotly();
    if (
      token !== state.chartRenderToken
      || analysisId !== state.currentAnalysisId
      || !dashboardIsVisible()
      || state.currentView !== "overview"
    ) {
      return;
    }
    const values = rows.map((row) => Number(row[metric]) || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    const labels = rows.map((row) => CATEGORY_LABELS[row.category] || row.category);
    const valueLabel = metric === "size" ? formatBytes(total) : `${formatNumber(total)} 件`;
    await Plotly.react(chart, [{
      type: "pie",
      hole: 0.62,
      sort: false,
      direction: "clockwise",
      labels,
      values,
      customdata: rows.map((row) => [
        row.category,
        formatBytes(row.size),
        formatNumber(row.count),
      ]),
      marker: {
        colors: rows.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]),
        line: { color: "rgba(248, 251, 255, 0.92)", width: 2 },
      },
      textinfo: "label+percent",
      textposition: "outside",
      hovertemplate: metric === "size"
        ? "<b>%{label}</b><br>容量 %{customdata[1]}<br>ファイル %{customdata[2]} 件<extra></extra>"
        : "<b>%{label}</b><br>ファイル %{customdata[2]} 件<br>容量 %{customdata[1]}<extra></extra>",
    }], {
      autosize: true,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { t: 24, r: 78, b: 24, l: 78 },
      showlegend: false,
      font: {
        family: 'Inter, "Noto Sans JP", system-ui, sans-serif',
        color: "#30425c",
        size: 12,
      },
      annotations: [{
        x: 0.5,
        y: 0.5,
        xref: "paper",
        yref: "paper",
        showarrow: false,
        align: "center",
        text: `<b>${valueLabel}</b><br><span style="font-size:11px;color:#687b95">${metric === "size" ? "合計容量" : "合計ファイル数"}</span>`,
        font: { color: "#162a46", size: 20 },
      }],
      transition: { duration: 220, easing: "cubic-in-out" },
    }, {
      responsive: true,
      displaylogo: false,
      scrollZoom: false,
      modeBarButtonsToRemove: [
        "toImage",
        "select2d",
        "lasso2d",
        "autoScale2d",
      ],
    });
    if (token !== state.chartRenderToken || analysisId !== state.currentAnalysisId) {
      Plotly.purge(chart);
      return;
    }
    chart.removeAllListeners?.("plotly_click");
    chart.on?.("plotly_click", (event) => {
      const category = event?.points?.[0]?.customdata?.[0];
      if (category) {
        window.location.assign(buildMainUrl({ category }));
      }
    });
    chart.classList.remove("hidden");
    status.classList.add("hidden");
    chart.setAttribute(
      "aria-label",
      `ファイル種類別の${metric === "size" ? "容量" : "ファイル数"}分布。項目を選ぶとファイル一覧を表示します。`,
    );
  } catch (error) {
    if (token !== state.chartRenderToken) {
      return;
    }
    console.error("Interactive chartを表示できませんでした。", error);
    chart.classList.add("hidden");
    status.textContent = "チャートを表示できませんでした。下の表から分布を確認できます。";
    status.classList.add("error");
  }
}

function renderCapacityDistribution(meta, extensions = [], rows = categoryRows(meta, extensions)) {
  const body = byId("capacity-distribution-body");
  const table = byId("capacity-distribution-table");
  const empty = byId("capacity-distribution-empty");
  if (!body || !table || !empty) {
    return;
  }
  const totalSize = Math.max(
    0,
    Number(meta?.totalSize) || rows.reduce((sum, row) => sum + row.size, 0),
  );
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    const ratio = totalSize > 0 ? Math.min(100, row.size / totalSize * 100) : 0;
    const bar = createElement("span", {
      className: "capacity-ratio-bar",
      attributes: { "aria-hidden": "true" },
    });
    bar.style.setProperty("--capacity-ratio", `${ratio}%`);
    const ratioCell = createElement("td", {
      className: "capacity-ratio-cell",
      attributes: {
        "aria-label": `${ratio.toFixed(1)}パーセント`,
      },
    }, createElement("span", {
      className: "capacity-ratio-layout",
    }, [
      bar,
      createElement("span", { text: `${ratio.toFixed(1)}%` }),
    ]));
    fragment.appendChild(createElement("tr", {}, [
      createElement("th", {
        attributes: { scope: "row" },
      }, createElement("a", {
        text: CATEGORY_LABELS[row.category] || row.category,
        href: buildMainUrl({ category: row.category }),
        className: "capacity-category-link",
        title: `${CATEGORY_LABELS[row.category] || row.category}のファイル一覧を表示`,
      })),
      createElement("td", {
        text: formatBytes(row.size),
        className: "numeric-cell",
      }),
      ratioCell,
      createElement("td", {
        text: formatNumber(row.count),
        className: "numeric-cell",
      }),
    ]));
  });
  body.replaceChildren(fragment);
  const hasRows = rows.length > 0;
  table.classList.toggle("hidden", !hasRows);
  empty.classList.toggle("hidden", hasRows);
  if (!hasRows) {
    empty.textContent = meta
      ? "容量の分布データがありません。"
      : "解析後に容量の分布を表示します。";
  }
}

function renderOverview(meta, extensions = []) {
  const available = Boolean(meta);
  state.chartRows = available ? categoryRows(meta, extensions) : [];
  setText("overview-folder", meta?.rootName || "-");
  const folder = byId("overview-folder");
  if (folder) {
    folder.title = meta?.rootName || "";
  }
  setText("overview-total-size", available ? formatBytes(meta.totalSize) : "-");
  setText("overview-total-files", available ? formatNumber(meta.totalFiles) : "-");
  setText("overview-status", available ? "解析済み" : "解析結果なし");
  setText(
    "overview-note",
    available
      ? `フォルダ数 ${formatNumber(meta.totalDirectories)}・解析日時 ${formatDate(meta.analyzedAt)}`
      : "フォルダを解析すると、ここに合計情報を表示します。",
  );
  byId("overview-status")?.classList.toggle("is-ready", available);
  renderCapacityDistribution(meta, extensions, state.chartRows);
  if (!available) {
    purgeMainChart();
  }
}

function setBusy(value) {
  state.busy = value;
  const analyze = byId("analyze-button");
  const cancel = byId("cancel-button");
  const input = byId("folder-input");
  if (analyze) {
    analyze.disabled = value || !state.ready;
    analyze.setAttribute("aria-busy", String(value));
    analyze.textContent = value
      ? "解析中..."
      : state.ready ? "フォルダを解析" : "準備中...";
  }
  if (input) {
    input.disabled = value;
  }
  cancel?.classList.toggle("hidden", !value);
  byId("progress-panel")?.classList.toggle("hidden", !value);
  if (value) {
    state.startedAt = performance.now();
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = window.setInterval(() => {
      setText("progress-elapsed", `経過 ${Math.floor((performance.now() - state.startedAt) / 1000)}秒`);
    }, 250);
  } else {
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = 0;
  }
  syncPrimaryLayout();
}

function updateProgress(progress = {}) {
  const total = Math.max(0, Number(progress.total) || 0);
  const processed = Math.max(0, Math.min(total || Infinity, Number(progress.processed) || 0));
  const percent = Math.max(
    0,
    Math.min(100, Math.round(Number(progress.percent) || (total ? processed / total * 100 : 0))),
  );
  byId("progress-panel")?.classList.remove("hidden");
  setText("progress-title", progress.stage || "解析中");
  setText("progress-description", progress.message || "フォルダを解析しています。");
  setText("progress-percentage", `${percent}%`);
  setText("progress-count", `${formatNumber(processed)} / ${formatNumber(total)} ファイル`);
  setText("progress-stage", progress.stage || "解析中");
  const elapsedMs = Number(progress.elapsedMs);
  const elapsed = Number.isFinite(elapsedMs)
    ? elapsedMs
    : state.startedAt ? performance.now() - state.startedAt : 0;
  setText("progress-elapsed", `経過 ${(elapsed / 1000).toFixed(elapsed >= 10000 ? 0 : 1)}秒`);
  const fill = byId("progress-fill");
  if (fill) {
    fill.style.width = `${percent}%`;
  }
  const bar = byId("progress-bar");
  bar?.setAttribute("aria-valuenow", String(percent));
}

function setAnalysisControls(available, meta = null) {
  document.querySelectorAll("[data-analysis-link], [data-analysis-action]").forEach((element) => {
    element.classList.toggle("is-disabled", !available);
    element.setAttribute("aria-disabled", String(!available));
    if (available) {
      element.removeAttribute("tabindex");
    } else {
      element.setAttribute("tabindex", "-1");
    }
  });
  if (byId("reuse-analysis-button")) {
    byId("reuse-analysis-button").disabled = !available;
  }
  if (byId("delete-analysis-button")) {
    byId("delete-analysis-button").disabled = !available;
  }
  if (byId("dashboard-delete-analysis-button")) {
    byId("dashboard-delete-analysis-button").disabled = !available;
  }
  document.querySelectorAll("[data-requires-analysis]").forEach((element) => {
    const disabled = !available || (
      element.dataset.mainView === "files" && !state.table
    );
    element.disabled = disabled;
    element.setAttribute("aria-disabled", String(disabled));
  });

  const nextAnalysisId = available && meta ? String(meta.analysisId || "") : null;
  if (nextAnalysisId !== state.currentAnalysisId) {
    state.currentAnalysisId = nextAnalysisId;
    state.loadedAnalysisId = null;
    state.tableLoaded = false;
    void state.table?.clear();
  }
  renderOverview(available && meta ? meta : null);
  if (!available && state.currentView !== "overview") {
    setMainView("overview", { renderChart: false });
  }
  syncPrimaryLayout({ renderChart: false });
}

function queryCriteria() {
  const minimumMb = Number(byId("min-size-filter")?.value || 0);
  const maximumText = String(byId("max-size-filter")?.value || "").trim();
  const maximumMb = maximumText ? Number(maximumText) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(maximumMb) && minimumMb > maximumMb) {
    throw new Error("最大サイズには最小サイズ以上の値を指定してください。");
  }
  const from = parseDateStart(byId("modified-from-filter")?.value);
  const to = parseDateEnd(byId("modified-to-filter")?.value);
  if (from > to) {
    throw new Error("更新日の終了日は開始日以降を指定してください。");
  }
  const name = String(byId("file-name-search")?.value || "").trim();
  const useRegex = Boolean(byId("regex-filter")?.checked);
  if (useRegex && name) {
    try {
      void new RegExp(name, "iu");
    } catch {
      throw new Error("正規表現が正しくありません。入力内容を確認してください。");
    }
  }
  const criteria = {
    name,
    path: String(byId("path-search")?.value || "").trim(),
    extension: String(byId("extension-filter")?.value || ""),
    category: String(byId("category-filter")?.value || ""),
    sortBy: String(byId("sort-by")?.value || "size"),
    direction: String(byId("sort-direction")?.value || "desc"),
    useRegex,
    regex: useRegex ? name : "",
    minSize: Number.isFinite(minimumMb) && minimumMb > 0
      ? Math.round(minimumMb * MEGABYTE)
      : 0,
    maxSize: Number.isFinite(maximumMb) && maximumMb >= 0
      ? Math.round(maximumMb * MEGABYTE)
      : Number.POSITIVE_INFINITY,
    updatedFrom: from,
    updatedTo: to,
  };
  const urlCriteria = queryFromUrl();
  if (urlCriteria.directory) {
    criteria.directory = urlCriteria.directory;
  }
  if (urlCriteria.ageBucket) {
    criteria.ageBucket = urlCriteria.ageBucket;
  }
  return criteria;
}

async function runQuery(options = {}) {
  if (!state.table || !state.status?.available) {
    return;
  }
  const token = ++state.queryToken;
  const criteria = queryCriteria();
  showMessage("form-message");
  setText("filtered-stats", "検索中...");
  const executeQuery = () => Storage.queryFileIds(criteria, {
    isCancelled: () => token !== state.queryToken,
    onProgress: ({ processed, total, matched }) => {
      if (token !== state.queryToken) {
        return;
      }
      setText(
        "filtered-stats",
        total
          ? `検索中: ${formatNumber(processed)} / ${formatNumber(total)}（一致 ${formatNumber(matched)}）`
          : "検索中...",
      );
    },
  });
  const hasSearch = Boolean(criteria.name || criteria.path || criteria.useRegex);
  const hasFilter = Boolean(
    criteria.extension
    || criteria.category
    || criteria.directory
    || criteria.ageBucket
    || criteria.minSize > 0
    || Number.isFinite(criteria.maxSize)
    || criteria.updatedFrom > 0
    || Number.isFinite(criteria.updatedTo),
  );
  const runSearch = () => (
    hasSearch ? measured("search", executeQuery) : executeQuery()
  );
  const runFilter = () => (
    hasFilter ? measured("filter", runSearch) : runSearch()
  );
  const result = await measured("sort", runFilter);
  if (token !== state.queryToken || result.cancelled) {
    return;
  }
  setText(
    "filtered-stats",
    `${formatNumber(result.totalCount)} ファイル / ${formatBytes(result.totalSize)}`,
  );
  const renderTable = () => state.table.setData(
    result.ids,
    { preserveScroll: Boolean(options.preserveScroll) },
  );
  if (options.initial) {
    await measured("initial table render", renderTable);
  } else {
    await renderTable();
  }
  state.tableLoaded = true;
  state.loadedAnalysisId = state.currentAnalysisId;
}

function populateExtensions(rows) {
  const select = byId("extension-filter");
  if (!select) {
    return;
  }
  const selected = select.value;
  const fragment = document.createDocumentFragment();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "すべて";
  fragment.appendChild(all);
  [...rows]
    .sort((a, b) => String(a.extension).localeCompare(String(b.extension), "ja"))
    .forEach((row) => {
      const option = document.createElement("option");
      option.value = row.extension || "";
      option.textContent = row.extension || "(拡張子なし)";
      fragment.appendChild(option);
    });
  select.replaceChildren(fragment);
  if ([...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
}

function applyUrlFilters() {
  const criteria = queryFromUrl();
  const mappings = [
    ["name", "file-name-search"],
    ["path", "path-search"],
    ["extension", "extension-filter"],
    ["category", "category-filter"],
    ["sortBy", "sort-by"],
    ["direction", "sort-direction"],
  ];
  mappings.forEach(([key, id]) => {
    const element = byId(id);
    if (element && criteria[key]) {
      element.value = criteria[key];
    }
  });
  if (Number.isFinite(criteria.minSize)) {
    byId("min-size-filter").value = String(criteria.minSize / MEGABYTE);
  }
  if (Number.isFinite(criteria.maxSize)) {
    byId("max-size-filter").value = String(criteria.maxSize / MEGABYTE);
  }
  if (criteria.updatedFrom) {
    byId("modified-from-filter").value = new Date(criteria.updatedFrom).toISOString().slice(0, 10);
  }
  if (Number.isFinite(criteria.updatedTo)) {
    byId("modified-to-filter").value = new Date(criteria.updatedTo).toISOString().slice(0, 10);
  }
  byId("regex-filter").checked = Boolean(criteria.useRegex);
}

async function loadSavedSearchFromUrl() {
  const id = new URLSearchParams(window.location.search).get("savedSearch");
  if (!id) {
    return;
  }
  const saved = (await Storage.listSavedSearches()).find((row) => String(row.id) === id);
  if (!saved) {
    showMessage("form-message", "指定された保存済み検索が見つかりません。", "warning");
    return;
  }
  const criteria = saved.criteria || {};
  const fields = {
    name: "file-name-search",
    path: "path-search",
    extension: "extension-filter",
    category: "category-filter",
    sortBy: "sort-by",
    direction: "sort-direction",
  };
  Object.entries(fields).forEach(([key, idValue]) => {
    const element = byId(idValue);
    if (element && criteria[key] !== undefined) {
      element.value = String(criteria[key]);
    }
  });
  byId("min-size-filter").value = criteria.minSizeMb ?? "";
  byId("max-size-filter").value = criteria.maxSizeMb ?? "";
  byId("modified-from-filter").value = criteria.dateFrom || "";
  byId("modified-to-filter").value = criteria.dateTo || "";
  byId("regex-filter").checked = Boolean(criteria.useRegex);
  showMessage("form-message", `保存済み検索「${saved.name}」を適用しました。`, "success");
}

async function loadAnalysis(options = {}) {
  const params = new URLSearchParams(window.location.search);
  const requestedByUrl = params.has("savedSearch")
    || Object.keys(queryFromUrl()).length > 0;
  state.status = await Storage.getAnalysisStatus();
  state.formOpen = !state.status.available;
  if (state.status.available && requestedByUrl) {
    state.currentView = "files";
  }
  setAnalysisControls(Boolean(state.status.available), state.status.meta);
  if (!state.status.available) {
    await state.table?.clear();
    setText("filtered-stats", "解析結果がありません。");
    return;
  }
  const extensions = await Storage.getExtensions();
  populateExtensions(extensions);
  renderOverview(state.status.meta, extensions);
  applyUrlFilters();
  await loadSavedSearchFromUrl();
  if (requestedByUrl || state.currentView === "files" || options.loadFiles) {
    setMainView("files");
    await runQuery({
      preserveScroll: options.preserveScroll,
      initial: Boolean(options.initial || !state.tableLoaded),
    });
  } else {
    setMainView("overview", { renderChart: false });
    setText("filtered-stats", "ファイル一覧を開くと読み込みます。");
    syncPrimaryLayout();
  }
}

async function startAnalysis(fileList) {
  if (!state.ready) {
    throw new Error("保存領域を準備しています。完了するまで少しお待ちください。");
  }
  if (!fileList?.length) {
    throw new Error("解析するフォルダを選択してください。");
  }
  const token = ++state.analysisToken;
  state.queryToken += 1;
  state.formOpen = true;
  state.status = { available: false, usable: false, meta: null };
  setBusy(true);
  setAnalysisControls(false);
  showMessage("form-message", "フォルダの解析を開始しました。", "success");
  updateProgress({
    stage: "ファイル情報を準備中",
    message: "通常解析ではファイル内容を読みません。",
    processed: 0,
    total: fileList.length,
    percent: 0,
  });
  try {
    const settings = state.settings || await Storage.getSettings();
    const result = await Analyzer.analyze(fileList, {
      oldFileDays: Number(settings.oldFileDays) || 365,
      largeFileBytes: (Number(settings.largeFileMb) || 100) * MEGABYTE,
      deepPathDepth: Number(settings.deepPathDepth) || 10,
      longPathLength: Number(settings.longPathLength) || 180,
      onProgress: (progress) => {
        if (token === state.analysisToken) {
          updateProgress(progress);
        }
      },
    });
    if (token !== state.analysisToken) {
      return;
    }
    updateProgress({
      stage: "完了",
      message: result.historyWarning
        ? "解析は完了しましたが、保存容量の都合で履歴を保存できませんでした。"
        : "解析結果と履歴をブラウザへ保存しました。",
      processed: fileList.length,
      total: fileList.length,
      percent: 100,
      elapsedMs: result.timings?.totalDurationMs,
    });
    showMessage("form-message", "フォルダの解析が完了しました。", "success");
    await loadAnalysis();
    await window.FolderVisualizer?.BasePage?.refreshStatus?.();
  } catch (error) {
    if (token !== state.analysisToken) {
      return;
    }
    const cancelled = error?.name === "AbortError";
    showMessage(
      "form-message",
      cancelled ? "解析をキャンセルしました。" : (error?.message || "解析中にエラーが発生しました。"),
      cancelled ? "warning" : "error",
    );
    updateProgress({
      stage: cancelled ? "キャンセル" : "エラー",
      message: cancelled ? "解析をキャンセルしました。" : "解析を完了できませんでした。",
      total: fileList.length,
      processed: 0,
      percent: 0,
    });
    await loadAnalysis();
  } finally {
    if (token === state.analysisToken) {
      setBusy(false);
    }
  }
}

async function cancelAnalysis() {
  if (!state.busy) {
    return;
  }
  state.analysisToken += 1;
  await Analyzer.cancel();
  setBusy(false);
  showMessage("form-message", "解析をキャンセルしました。", "warning");
  updateProgress({ stage: "キャンセル", message: "解析をキャンセルしました。", percent: 0 });
  await loadAnalysis();
}

async function deleteCurrentAnalysis() {
  if (!state.status?.available) {
    return;
  }
  if (!window.confirm("現在の解析結果をこのブラウザから削除します。保存済み履歴は残ります。続行しますか？")) {
    return;
  }
  state.queryToken += 1;
  await Storage.clearAnalysis(state.status.meta?.analysisId);
  Analyzer.clearSessionFiles();
  showMessage("form-message", "現在の解析結果を削除しました。", "success");
  await loadAnalysis();
  await window.FolderVisualizer?.BasePage?.refreshStatus?.();
}

function bindFilters() {
  const delay = Math.max(100, Number(state.settings?.searchDebounceMs) || 250);
  const debounced = debounce(() => {
    void runQuery().catch((error) => showMessage("form-message", error.message, "error"));
  }, delay);
  [
    "file-name-search",
    "path-search",
    "min-size-filter",
    "max-size-filter",
    "modified-from-filter",
    "modified-to-filter",
  ].forEach((id) => byId(id)?.addEventListener("input", debounced));
  [
    "extension-filter",
    "category-filter",
    "sort-by",
    "sort-direction",
    "regex-filter",
  ].forEach((id) => byId(id)?.addEventListener("change", () => {
    void runQuery().catch((error) => showMessage("form-message", error.message, "error"));
  }));
}

async function activateMainView(view) {
  if (view === "files" && !state.status?.available) {
    return;
  }
  setMainView(view);
  if (view === "files" && (
    !state.tableLoaded
    || state.loadedAnalysisId !== state.currentAnalysisId
  )) {
    await runQuery({ initial: true });
  }
}

function bindMainViewSwitcher() {
  const buttons = [...document.querySelectorAll("[data-main-view]")];
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      void activateMainView(button.dataset.mainView).catch((error) => {
        showMessage("form-message", error?.message || "表示を切り替えられませんでした。", "error");
      });
    });
    button.addEventListener("keydown", (event) => {
      const enabled = buttons.filter((item) => !item.disabled);
      const current = enabled.indexOf(button);
      let next = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (current + 1) % enabled.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (current - 1 + enabled.length) % enabled.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = enabled.length - 1;
      }
      if (next < 0) {
        return;
      }
      event.preventDefault();
      const target = enabled[next];
      target.focus();
      void activateMainView(target.dataset.mainView).catch((error) => {
        showMessage("form-message", error?.message || "表示を切り替えられませんでした。", "error");
      });
    });
  });
}

function bindInterface() {
  if (state.eventsBound) {
    return;
  }
  state.eventsBound = true;
  byId("analyze-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void startAnalysis(byId("folder-input")?.files).catch((error) => {
      showMessage(
        "form-message",
        error?.message || "フォルダの解析を開始できませんでした。",
        "error",
      );
      setBusy(false);
    });
  });
  byId("cancel-button")?.addEventListener("click", () => {
    void cancelAnalysis().catch((error) => {
      showMessage("form-message", error?.message || "解析を中断できませんでした。", "error");
    });
  });
  byId("reuse-analysis-button")?.addEventListener("click", returnToDashboard);
  byId("open-analyzer-button")?.addEventListener("click", openAnalysisForm);
  byId("delete-analysis-button")?.addEventListener("click", () => void deleteCurrentAnalysis());
  byId("dashboard-delete-analysis-button")?.addEventListener(
    "click",
    () => void deleteCurrentAnalysis(),
  );
  document.querySelectorAll("[data-chart-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartMetric = button.dataset.chartMetric === "count" ? "count" : "size";
      document.querySelectorAll("[data-chart-metric]").forEach((candidate) => {
        const active = candidate.dataset.chartMetric === state.chartMetric;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      setText(
        "main-chart-description",
        state.chartMetric === "size"
          ? "ファイル種類ごとの使用容量です。項目を選ぶと該当ファイルを表示できます。"
          : "ファイル種類ごとのファイル数です。項目を選ぶと該当ファイルを表示できます。",
      );
      void renderMainChart();
    });
  });
  bindMainViewSwitcher();
  bindFilters();
}

async function initializeVirtualTable() {
  try {
    await import("../virtual-table.js");
  } catch (error) {
    console.error("ファイル一覧の表示機能を読み込めませんでした。", error);
    return false;
  }
  const VirtualFileTable = window.FolderVisualizer?.VirtualTable?.VirtualFileTable
    || window.FolderVisualizer?.VirtualFileTable;
  if (!VirtualFileTable) {
    return false;
  }
  state.table = new VirtualFileTable({
    getFilesByIds: Storage.getFilesByIds,
    initialSize: state.settings.tableSize || "medium",
    onError: (error) => showMessage(
      "form-message",
      error?.message || "ファイル一覧を読み込めませんでした。",
      "error",
    ),
  });
  return true;
}

async function initialize() {
  // Bind submit and cancel before the first IndexedDB/import await. If browser
  // storage is blocked, the form now shows the actual error instead of falling
  // through to a CSP-blocked native submission.
  bindInterface();
  syncPrimaryLayout({ renderChart: false });
  try {
    state.settings = await Storage.getSettings();
    window.FolderVisualizer.performanceLogging = Boolean(state.settings.performanceLogging);
    const tableReady = await initializeVirtualTable();
    if (!tableReady) {
      showMessage(
        "form-message",
        "ファイル一覧を準備できませんでした。解析は実行できますが、更新後に再読み込みしてください。",
        "warning",
      );
    }
    await loadAnalysis({ initial: true });
    setReady(true);
    setAnalysisControls(Boolean(state.status?.available), state.status?.meta);
    syncPrimaryLayout();
  } catch (error) {
    state.formOpen = true;
    setReady(false);
    syncPrimaryLayout({ renderChart: false });
    console.error("Folder Visualizerを初期化できませんでした。", error);
    showMessage(
      "form-message",
      error?.message
        || "アプリの保存領域を準備できませんでした。ページを再読み込みしてください。",
      "error",
    );
  }
}

initializeWhenReady(initialize);

window.FolderVisualizer = window.FolderVisualizer || {};
window.FolderVisualizer.IndexPage = Object.freeze({
  getState: () => ({
    busy: state.busy,
    status: state.status,
    currentView: state.currentView,
    tableLoaded: state.tableLoaded,
    chartMetric: state.chartMetric,
    dashboardVisible: dashboardIsVisible(),
    table: state.table?.getState(),
  }),
  activateMainView,
  loadAnalysis,
  runQuery,
  startAnalysis,
});
