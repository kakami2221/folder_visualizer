import {
  Storage,
  buildMainUrl,
  createElement,
  ensureAnalysis,
  formatBytes,
  formatNumber,
  initializeWhenReady,
  measured,
  requirePlotly,
  setText,
  showMessage,
} from "./page-utils.js";

const MAX_CHART_BARS = 50;

const state = {
  extensions: [],
  mode: "size",
  renderRequestId: 0,
  renderQueue: Promise.resolve(),
};

function displayExtension(value) {
  return value && value !== "(no extension)" ? value : "(拡張子なし)";
}

export function sortedExtensions(mode = state.mode) {
  const primary = mode === "count" ? "count" : "size";
  const secondary = primary === "size" ? "count" : "size";
  return [...state.extensions].sort((left, right) => (
    (Number(right[primary]) - Number(left[primary]))
    || (Number(right[secondary]) - Number(left[secondary]))
    || String(left.extension).localeCompare(String(right.extension), "ja")
  ));
}

function renderTable(rows) {
  const body = document.getElementById("extensions-body");
  if (!body) {
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((item) => {
    const row = document.createElement("tr");
    const extensionCell = document.createElement("td");
    const link = createElement("a", {
      href: buildMainUrl({ extension: item.extension }),
      text: displayExtension(item.extension),
      title: `${displayExtension(item.extension)} のファイルを見る`,
    });
    extensionCell.appendChild(link);
    const count = Number(item.count) || 0;
    row.append(
      extensionCell,
      createElement("td", { text: formatBytes(item.size) }),
      createElement("td", { text: formatNumber(count) }),
      createElement("td", {
        text: formatBytes(count > 0 ? Number(item.size) / count : 0),
      }),
    );
    fragment.appendChild(row);
  });
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = createElement("td", {
      text: "表示できる拡張子情報がありません。",
      attributes: { colspan: "4" },
    });
    row.appendChild(cell);
    fragment.appendChild(row);
  }
  body.replaceChildren(fragment);
}

function updateModeButtons() {
  document.querySelectorAll("[data-extension-mode]").forEach((button) => {
    const active = button.dataset.extensionMode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function bindChartNavigation(chart, chartItems) {
  if (typeof chart.removeAllListeners === "function") {
    chart.removeAllListeners("plotly_click");
  }
  chart.on?.("plotly_click", (event) => {
    const index = Number(event?.points?.[0]?.pointIndex);
    const item = Number.isInteger(index) ? chartItems[index] : null;
    if (item) {
      window.location.assign(buildMainUrl({ extension: item.extension }));
    }
  });
}

export async function renderExtensions(mode = state.mode) {
  const Plotly = await requirePlotly();
  state.mode = mode === "count" ? "count" : "size";
  const requestId = ++state.renderRequestId;
  const ordered = sortedExtensions(state.mode);
  renderTable(ordered);
  updateModeButtons();

  const chartItems = ordered.slice(0, MAX_CHART_BARS);
  const valueKey = state.mode === "count" ? "count" : "size";
  const otherKey = state.mode === "count" ? "size" : "count";
  const chart = document.getElementById("extension-chart");
  const queued = state.renderQueue.catch(() => {}).then(() => measured(
    "extension chart",
    async () => {
      if (requestId !== state.renderRequestId || !chart) {
        return;
      }
      await Plotly.react(chart, [{
        type: "bar",
        x: chartItems.map((item) => displayExtension(item.extension)),
        y: chartItems.map((item) => Number(item[valueKey]) || 0),
        customdata: chartItems.map((item) => Number(item[otherKey]) || 0),
        marker: {
          color: "#245852",
          line: { color: "#173633", width: 1.2 },
        },
        hovertemplate: state.mode === "count"
          ? "<b>%{x}</b><br>件数: %{y:,.0f}<br>容量: %{customdata:,.0f} bytes<extra></extra>"
          : "<b>%{x}</b><br>容量: %{y:,.0f} bytes<br>件数: %{customdata:,.0f}<extra></extra>",
      }], {
        margin: { t: 10, r: 10, b: 80, l: 70 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#1f2523" },
        xaxis: { tickangle: -35, automargin: true },
        yaxis: {
          title: state.mode === "count" ? "ファイル数" : "容量 (bytes)",
          rangemode: "tozero",
        },
      }, {
        responsive: true,
        displayModeBar: false,
      });
      bindChartNavigation(chart, chartItems);
    },
  ));
  state.renderQueue = queued;
  await queued;

  showMessage(
    "page-message",
    ordered.length > MAX_CHART_BARS
      ? `グラフは上位${MAX_CHART_BARS}件を表示しています。全件は一覧表で確認できます。`
      : "グラフまたは一覧の拡張子を選ぶと、該当ファイルを表示します。",
    ordered.length > MAX_CHART_BARS ? "warning" : "",
  );
}

export async function initializeExtensionsPage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  state.extensions = await Storage.getExtensions();
  setText(
    "extension-size-total",
    formatBytes(state.extensions.reduce((sum, item) => sum + (Number(item.size) || 0), 0)),
  );
  setText(
    "extension-count-total",
    formatNumber(state.extensions.reduce((sum, item) => sum + (Number(item.count) || 0), 0)),
  );
  document.querySelectorAll("[data-extension-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      void renderExtensions(button.dataset.extensionMode).catch((error) => {
        showMessage("page-message", error?.message || "グラフを表示できませんでした。", "error");
      });
    });
  });
  await renderExtensions("size");
}

initializeWhenReady(initializeExtensionsPage);

