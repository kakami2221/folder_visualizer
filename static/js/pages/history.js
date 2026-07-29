import { compareSources, cancelComparison } from "../analysis/compare-controller.js";
import {
  Storage,
  byId,
  createElement,
  formatBytes,
  formatDate,
  formatNumber,
  formatSignedBytes,
  formatSignedNumber,
  initializeWhenReady,
  measured,
  requirePlotly,
  setText,
  showMessage,
} from "./page-utils.js";

const state = {
  history: [],
  selected: new Set(),
  comparisonToken: 0,
};

function renderHistory() {
  const body = byId("history-body");
  const empty = byId("history-empty");
  const content = byId("history-content");
  const hasHistory = state.history.length > 0;
  empty?.classList.toggle("hidden", hasHistory);
  content?.classList.toggle("hidden", !hasHistory);
  if (!body) {
    return;
  }
  const fragment = document.createDocumentFragment();
  state.history.forEach((item) => {
    const checkbox = createElement("input", {
      type: "checkbox",
      dataset: { historyId: item.analysisId },
      attributes: { "aria-label": `${item.rootName || "解析"} ${formatDate(item.analyzedAt)}を選択` },
    });
    checkbox.checked = state.selected.has(String(item.analysisId));
    const row = createElement("tr", {}, [
      createElement("td", {}, [checkbox]),
      createElement("td", { text: formatDate(item.analyzedAt) }),
      createElement("td", { text: item.rootName || "-", title: item.rootName || "" }),
      createElement("td", { text: formatBytes(item.totalSize) }),
      createElement("td", { text: formatNumber(item.totalFiles) }),
      createElement("td", { text: formatNumber(item.totalDirectories) }),
    ]);
    fragment.appendChild(row);
  });
  body.replaceChildren(fragment);
  byId("compare-selected-history").disabled = state.selected.size !== 2;
  byId("delete-selected-history").disabled = state.selected.size === 0;
}

async function loadHistory() {
  state.history = await Storage.listHistory();
  state.selected.clear();
  renderHistory();
}

function appendDifferenceList(targetId, rows) {
  const target = byId(targetId);
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.slice(0, 30).forEach((row) => {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: row.relativePath, title: row.relativePath }),
      createElement("strong", {
        text: row.status === "only-a"
          ? formatBytes(row.a?.size)
          : row.status === "only-b"
            ? formatBytes(row.b?.size)
            : formatSignedBytes(row.sizeDelta),
      }),
    ]));
  });
  if (rows.length > 30) {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: "表示を省略" }),
      createElement("strong", { text: `ほか${formatNumber(rows.length - 30)}件` }),
    ]));
  }
  if (!rows.length) {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: "該当なし" }),
      createElement("strong", { text: "0件" }),
    ]));
  }
  target.replaceChildren(fragment);
}

function aggregateDirectoryDeltas(results) {
  const directories = new Map();
  const observe = (file, side) => {
    if (!file) {
      return;
    }
    const parts = String(file.relativePath || "")
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);
    parts.pop();
    const paths = [];
    let current = "";
    parts.forEach((part) => {
      current = current ? `${current}/${part}` : part;
      paths.push(current);
    });
    if (!paths.length) {
      paths.push("(ルート直下)");
    }
    paths.forEach((path) => {
      const row = directories.get(path) || {
        path,
        a: 0,
        b: 0,
        countA: 0,
        countB: 0,
      };
      row[side] += Number(file.size) || 0;
      row[side === "a" ? "countA" : "countB"] += 1;
      directories.set(path, row);
    });
  };
  results.forEach((row) => {
    observe(row.a, "a");
    observe(row.b, "b");
  });
  return [...directories.values()].map((row) => ({
    ...row,
    delta: row.b - row.a,
    countDelta: row.countB - row.countA,
  }));
}

function changeDirection(row) {
  const sizeDelta = Number(row.delta) || 0;
  if (sizeDelta !== 0) {
    return Math.sign(sizeDelta);
  }
  return Math.sign(Number(row.countDelta) || 0);
}

function appendAggregateList(targetId, rows, labelKey, direction = 0) {
  const target = byId(targetId);
  if (!target) {
    return;
  }
  const filtered = rows
    .filter((row) => {
      const rowDirection = changeDirection(row);
      return direction === 0 ? rowDirection !== 0 : rowDirection === direction;
    })
    .sort((left, right) => (
      Math.abs(Number(right.delta) || 0) - Math.abs(Number(left.delta) || 0)
      || Math.abs(Number(right.countDelta) || 0) - Math.abs(Number(left.countDelta) || 0)
    ));
  const fragment = document.createDocumentFragment();
  filtered.slice(0, 20).forEach((row) => {
    const label = String(row[labelKey] || "(なし)");
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: label, title: label }),
      createElement("strong", {
        text: `${formatSignedBytes(row.delta)} / ${formatSignedNumber(row.countDelta)}件`,
      }),
    ]));
  });
  if (filtered.length > 20) {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: "表示を省略" }),
      createElement("strong", { text: `ほか${formatNumber(filtered.length - 20)}件` }),
    ]));
  }
  if (!filtered.length) {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: "該当なし" }),
      createElement("strong", { text: "0件" }),
    ]));
  }
  target.replaceChildren(fragment);
}

async function drawComparisonChart(summary, historyA, historyB) {
  const Plotly = await requirePlotly();
  const extensionRows = [...(summary.extensionDelta || [])]
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 15);
  const labels = extensionRows.map((row) => row.extension || "(拡張子なし)");
  const values = extensionRows.map((row) => row.delta);
  await Plotly.react("history-chart", [{
    type: "bar",
    orientation: "h",
    x: values,
    y: labels,
    marker: {
      color: values.map((value) => value >= 0 ? "#bf5f2d" : "#245852"),
    },
    hovertemplate: "%{y}<br>容量差: %{x:,.0f} bytes<extra></extra>",
  }], {
    margin: { t: 24, r: 24, b: 50, l: 110 },
    title: {
      text: `${historyA.rootName || "A"} → ${historyB.rootName || "B"}：拡張子別容量差`,
      font: { size: 14 },
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { title: "増減 (bytes)", zeroline: true },
  }, { responsive: true, displayModeBar: false });
}

async function compareSelected() {
  if (state.selected.size !== 2) {
    throw new Error("比較する履歴を2件選択してください。");
  }
  const token = ++state.comparisonToken;
  const selectedRows = [...state.selected]
    .map((id) => state.history.find((item) => String(item.analysisId) === id))
    .filter(Boolean)
    .sort((left, right) => Number(left.analyzedAt) - Number(right.analyzedAt));
  const [historyA, historyB] = selectedRows;
  showMessage("page-message", "履歴ファイルを読み込んでいます。");
  const [filesA, filesB] = await Promise.all([
    Storage.getHistoryFiles(historyA.analysisId),
    Storage.getHistoryFiles(historyB.analysisId),
  ]);
  if (token !== state.comparisonToken) {
    return;
  }
  const result = await measured("history comparison", () => compareSources(filesA, filesB, {
    comparisonId: `history:${historyA.analysisId}:${historyB.analysisId}`,
    onProgress: ({ processed, total }) => {
      if (token === state.comparisonToken) {
        showMessage(
          "page-message",
          `履歴を比較中: ${formatNumber(processed)} / ${formatNumber(total)}`,
        );
      }
    },
  }));
  if (token !== state.comparisonToken) {
    return;
  }
  const { summary, results } = result;
  const countA = Number(historyA.totalFiles) || filesA.length;
  const countB = Number(historyB.totalFiles) || filesB.length;
  const sizeA = Number(historyA.totalSize) || 0;
  const sizeB = Number(historyB.totalSize) || 0;
  const directoryA = Number(historyA.totalDirectories) || 0;
  const directoryB = Number(historyB.totalDirectories) || 0;
  const changed = results.filter((row) => (
    row.status === "size-changed" || row.status === "date-changed"
  ));
  setText("history-size-diff", formatSignedBytes(sizeB - sizeA));
  setText("history-file-diff", formatSignedNumber(countB - countA));
  setText("history-directory-diff", formatSignedNumber(directoryB - directoryA));
  setText("history-changed-count", formatNumber(changed.length));
  appendDifferenceList(
    "history-added",
    results.filter((row) => row.status === "only-b"),
  );
  appendDifferenceList(
    "history-removed",
    results.filter((row) => row.status === "only-a"),
  );
  appendDifferenceList("history-changed", changed);
  const directoryRows = aggregateDirectoryDeltas(results);
  appendAggregateList(
    "history-directories-increased",
    directoryRows,
    "path",
    1,
  );
  appendAggregateList(
    "history-directories-decreased",
    directoryRows,
    "path",
    -1,
  );
  appendAggregateList(
    "history-extension-delta",
    summary.extensionDelta || [],
    "extension",
  );
  appendAggregateList(
    "history-category-delta",
    summary.categoryDelta || [],
    "category",
  );
  byId("history-comparison")?.classList.remove("hidden");
  await drawComparisonChart(summary, historyA, historyB);
  showMessage(
    "page-message",
    `${formatDate(historyA.analyzedAt)}と${formatDate(historyB.analyzedAt)}を比較しました。`,
    "success",
  );
}

async function deleteSelected() {
  if (!state.selected.size) {
    return;
  }
  if (!window.confirm(`選択した${state.selected.size}件の解析履歴を削除しますか？`)) {
    return;
  }
  state.comparisonToken += 1;
  await cancelComparison();
  for (const id of state.selected) {
    await Storage.deleteHistory(id);
  }
  byId("history-comparison")?.classList.add("hidden");
  showMessage("page-message", "選択した解析履歴を削除しました。", "success");
  await loadHistory();
}

async function deleteAll() {
  if (!state.history.length || !window.confirm("保存済み解析履歴をすべて削除しますか？現在の解析結果は残ります。")) {
    return;
  }
  state.comparisonToken += 1;
  await cancelComparison();
  await Storage.clearHistory();
  byId("history-comparison")?.classList.add("hidden");
  showMessage("page-message", "解析履歴をすべて削除しました。", "success");
  await loadHistory();
}

function bindEvents() {
  byId("history-body")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-history-id]");
    if (!checkbox) {
      return;
    }
    const id = checkbox.dataset.historyId;
    if (checkbox.checked) {
      if (state.selected.size >= 2) {
        checkbox.checked = false;
        showMessage("page-message", "比較対象は2件まで選択できます。", "warning");
        return;
      }
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }
    renderHistory();
  });
  byId("compare-selected-history")?.addEventListener("click", () => {
    void compareSelected().catch((error) => {
      showMessage("page-message", error.message || "履歴比較に失敗しました。", "error");
    });
  });
  byId("delete-selected-history")?.addEventListener("click", () => {
    void deleteSelected().catch((error) => showMessage("page-message", error.message, "error"));
  });
  byId("delete-all-history")?.addEventListener("click", () => {
    void deleteAll().catch((error) => showMessage("page-message", error.message, "error"));
  });
}

async function initialize() {
  bindEvents();
  await loadHistory();
}

initializeWhenReady(initialize);
