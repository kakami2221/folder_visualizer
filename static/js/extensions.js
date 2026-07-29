(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common;
  const Storage = app.Storage || app.storage;
  const MAX_CHART_BARS = 50;

  const state = {
    extensions: [],
    mode: "size",
    renderRequestId: 0,
    renderQueue: Promise.resolve(),
  };

  function sortedExtensions(mode) {
    const primary = mode === "count" ? "count" : "size";
    const secondary = primary === "size" ? "count" : "size";
    return [...state.extensions].sort((left, right) => (
      (Number(right[primary]) - Number(left[primary]))
      || (Number(right[secondary]) - Number(left[secondary]))
      || String(left.extension).localeCompare(String(right.extension), "ja")
    ));
  }

  function renderTable(extensions) {
    const body = document.getElementById("extensions-body");
    if (!body) {
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of extensions) {
      const row = document.createElement("tr");
      const extension = document.createElement("td");
      const size = document.createElement("td");
      const count = document.createElement("td");
      const average = document.createElement("td");
      extension.textContent = item.extension || "(拡張子なし)";
      size.textContent = Common.formatBytes(item.size);
      count.textContent = Common.formatNumber(item.count);
      average.textContent = Common.formatBytes(
        Number(item.count) > 0 ? Number(item.size) / Number(item.count) : 0,
      );
      row.append(extension, size, count, average);
      fragment.appendChild(row);
    }
    if (!extensions.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "表示できる拡張子情報がありません。";
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

  async function render(mode = state.mode) {
    if (!window.Plotly?.react) {
      throw new Error("Plotly.jsを読み込めませんでした。ページを再読み込みしてください。");
    }
    state.mode = mode === "count" ? "count" : "size";
    const requestId = ++state.renderRequestId;
    const ordered = sortedExtensions(state.mode);
    renderTable(ordered);
    updateModeButtons();

    const chartItems = ordered.slice(0, MAX_CHART_BARS);
    const valueKey = state.mode === "count" ? "count" : "size";
    const otherKey = state.mode === "count" ? "size" : "count";
    const yTitle = state.mode === "count" ? "ファイル数" : "容量 (bytes)";
    const queuedRender = state.renderQueue.catch(() => {}).then(() => (
      Common.measureAsync("extension chart render", async () => {
        if (requestId !== state.renderRequestId) {
          return;
        }
        await window.Plotly.react("extension-chart", [{
          type: "bar",
          x: chartItems.map((item) => item.extension || "(拡張子なし)"),
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
          font: {
            family: "Segoe UI Variable Display, Segoe UI, Yu Gothic UI, sans-serif",
            color: "#1f2523",
          },
          xaxis: { tickangle: -35, automargin: true },
          yaxis: { title: yTitle, rangemode: "tozero" },
        }, {
          responsive: true,
          displayModeBar: false,
        });
      })
    ));
    state.renderQueue = queuedRender;
    await queuedRender;

    if (ordered.length > MAX_CHART_BARS) {
      Common.showMessage(
        "page-message",
        `グラフは上位${MAX_CHART_BARS}件を表示しています。全件は一覧表で確認できます。`,
        "warning",
      );
    } else {
      Common.showMessage("page-message", "", "");
    }
  }

  function showError(error) {
    console.error("拡張子分布を表示できませんでした。", error);
    Common.showMessage(
      "page-message",
      error?.message || "拡張子分布を表示できませんでした。",
      "error",
    );
  }

  async function initialize() {
    try {
      const status = await Common.showAnalysisState();
      if (!status.available) {
        return;
      }
      state.extensions = await Storage.getExtensions();
      const totalSize = state.extensions.reduce(
        (sum, item) => sum + (Number(item.size) || 0),
        0,
      );
      const totalCount = state.extensions.reduce(
        (sum, item) => sum + (Number(item.count) || 0),
        0,
      );
      Common.setText("extension-size-total", Common.formatBytes(totalSize));
      Common.setText("extension-count-total", Common.formatNumber(totalCount));
      document.querySelectorAll("[data-extension-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          void render(button.dataset.extensionMode).catch(showError);
        });
      });
      await render("size");
    } catch (error) {
      showError(error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });

  app.ExtensionsPage = Object.freeze({
    render,
    getState: () => ({
      mode: state.mode,
      extensionCount: state.extensions.length,
    }),
  });
})();
