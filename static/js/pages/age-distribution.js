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
  showMessage,
} from "./page-utils.js";

const state = {
  buckets: [],
  mode: "count",
  renderRequestId: 0,
  renderQueue: Promise.resolve(),
};

function percentage(value, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return "0.0%";
  }
  return `${((Number(value) || 0) / total * 100).toFixed(1)}%`;
}

function renderTable() {
  const body = document.getElementById("age-buckets-body");
  if (!body) {
    return;
  }
  const totalSize = state.buckets.reduce(
    (sum, bucket) => sum + (Number(bucket.size) || 0),
    0,
  );
  const fragment = document.createDocumentFragment();
  state.buckets.forEach((bucket) => {
    const row = document.createElement("tr");
    const linkCell = document.createElement("td");
    linkCell.appendChild(createElement("a", {
      href: buildMainUrl({ ageBucket: bucket.bucket }),
      text: "ファイルを見る",
      title: `${String(bucket.label || bucket.bucket)}のファイルを見る`,
    }));
    row.append(
      createElement("td", { text: bucket.label || bucket.bucket }),
      createElement("td", { text: formatNumber(bucket.count) }),
      createElement("td", { text: formatBytes(bucket.size) }),
      createElement("td", { text: percentage(Number(bucket.size) || 0, totalSize) }),
      linkCell,
    );
    fragment.appendChild(row);
  });
  if (!state.buckets.length) {
    const row = document.createElement("tr");
    row.appendChild(createElement("td", {
      text: "表示できるファイル年齢情報がありません。",
      attributes: { colspan: "5" },
    }));
    fragment.appendChild(row);
  }
  body.replaceChildren(fragment);
}

function updateModeButtons() {
  document.querySelectorAll("[data-age-mode]").forEach((button) => {
    const active = button.dataset.ageMode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function bindChartNavigation(chart) {
  if (typeof chart.removeAllListeners === "function") {
    chart.removeAllListeners("plotly_click");
  }
  chart.on?.("plotly_click", (event) => {
    const index = Number(event?.points?.[0]?.pointIndex);
    const bucket = Number.isInteger(index) ? state.buckets[index] : null;
    if (bucket) {
      window.location.assign(buildMainUrl({ ageBucket: bucket.bucket }));
    }
  });
}

export async function renderAgeDistribution(mode = state.mode) {
  const Plotly = await requirePlotly();
  state.mode = mode === "size" ? "size" : "count";
  const requestId = ++state.renderRequestId;
  updateModeButtons();
  const chart = document.getElementById("age-chart");
  const valueKey = state.mode;
  const secondaryKey = state.mode === "count" ? "size" : "count";
  const queued = state.renderQueue.catch(() => {}).then(() => measured(
    "age distribution",
    async () => {
      if (requestId !== state.renderRequestId || !chart) {
        return;
      }
      await Plotly.react(chart, [{
        type: "bar",
        x: state.buckets.map((bucket) => bucket.label || bucket.bucket),
        y: state.buckets.map((bucket) => Number(bucket[valueKey]) || 0),
        customdata: state.buckets.map((bucket) => Number(bucket[secondaryKey]) || 0),
        marker: {
          color: "#bf5f2d",
          line: { color: "#8d3b13", width: 1.2 },
        },
        hovertemplate: state.mode === "count"
          ? "<b>%{x}</b><br>件数: %{y:,.0f}<br>容量: %{customdata:,.0f} bytes<extra></extra>"
          : "<b>%{x}</b><br>容量: %{y:,.0f} bytes<br>件数: %{customdata:,.0f}<extra></extra>",
      }], {
        margin: { t: 10, r: 10, b: 70, l: 70 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#1f2523" },
        xaxis: { automargin: true },
        yaxis: {
          title: state.mode === "count" ? "ファイル数" : "容量 (bytes)",
          rangemode: "tozero",
        },
      }, {
        responsive: true,
        displayModeBar: false,
      });
      bindChartNavigation(chart);
    },
  ));
  state.renderQueue = queued;
  await queued;
}

export async function initializeAgeDistributionPage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  state.buckets = (await Storage.getAgeBuckets())
    .sort((left, right) => Number(left.order) - Number(right.order));
  renderTable();
  document.querySelectorAll("[data-age-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      void renderAgeDistribution(button.dataset.ageMode).catch((error) => {
        showMessage("page-message", error?.message || "年齢分布を表示できませんでした。", "error");
      });
    });
  });
  await renderAgeDistribution("count");
  showMessage("page-message", "グラフを選ぶと、その期間のファイルを表示します。");
}

initializeWhenReady(initializeAgeDistributionPage);

