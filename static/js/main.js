const state = {
  analysis: null,
  chartMode: "treemap",
  isBusy: false,
  plotlyPromise: null,
};

const form = document.getElementById("analyze-form");
const folderInput = document.getElementById("folder-input");
const messageBox = document.getElementById("form-message");
const dashboard = document.getElementById("dashboard");
const extensionFilter = document.getElementById("extension-filter");
const minSizeFilter = document.getElementById("min-size-filter");
const searchFilter = document.getElementById("search-filter");
const progressPanel = document.getElementById("progress-panel");
const progressBar = document.getElementById("progress-bar");
const progressTitle = document.getElementById("progress-title");
const progressDescription = document.getElementById("progress-description");
const progressPercentage = document.getElementById("progress-percentage");
const progressFill = document.getElementById("progress-fill");
const progressCount = document.getElementById("progress-count");
const progressStage = document.getElementById("progress-stage");

document.querySelectorAll("[data-chart-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (state.isBusy) {
      return;
    }

    state.chartMode = button.dataset.chartMode;
    document.querySelectorAll("[data-chart-mode]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    if (state.analysis) {
      await renderTreeChart(state.analysis.tree);
    }
  });
});

[extensionFilter, minSizeFilter, searchFilter].forEach((element) => {
  element.addEventListener("input", () => {
    if (state.analysis) {
      renderFilesSection();
    }
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (state.isBusy) {
    return;
  }

  const selectedFiles = [...folderInput.files];
  if (!selectedFiles.length) {
    setMessage("解析したいフォルダを選択してください。", "error");
    return;
  }

  setMessage("フォルダの解析を開始しました。", "success");
  toggleBusy(true);
  updateProgress({
    percent: 0,
    title: "フォルダ読み込み中...",
    description: "ファイル情報の収集を開始しています。",
    countLabel: `0 / ${formatNumber(selectedFiles.length)} files processed`,
    stageLabel: "準備中",
    visible: true,
  });

  try {
    const payload = await analyzeFiles(selectedFiles, updateProgress);
    state.analysis = payload;
    await hydrateDashboard(payload);
    updateProgress({
      percent: 100,
      title: "完了",
      description: "解析結果の表示が完了しました。",
      countLabel: `${formatNumber(payload.summary.total_files)} / ${formatNumber(payload.summary.total_files)} files processed`,
      stageLabel: "完了",
      visible: true,
    });
    setMessage("フォルダの解析が完了しました。", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーが発生しました。";
    dashboard.classList.add("hidden");
    updateProgress({
      percent: 0,
      title: "エラー",
      description: message,
      countLabel: "0 / 0 files processed",
      stageLabel: "エラー",
      visible: true,
    });
    setMessage(message, "error");
  } finally {
    toggleBusy(false);
    window.setTimeout(() => {
      if (!state.isBusy && state.analysis) {
        progressPanel.classList.add("hidden");
      }
    }, 900);
  }
});

async function hydrateDashboard(data) {
  dashboard.classList.remove("hidden");

  document.getElementById("summary-size").textContent = formatBytes(data.summary.total_size);
  document.getElementById("summary-files").textContent = formatNumber(data.summary.total_files);
  document.getElementById("summary-dirs").textContent = formatNumber(data.summary.total_dirs);
  document.getElementById("summary-root").textContent = data.summary.root_path;

  populateExtensionFilter(data.extensions);
  updateProgress({
    percent: 82,
    title: "可視化準備中...",
    description: "グラフライブラリを読み込み、表示データを組み立てています。",
    countLabel: `${formatNumber(data.summary.total_files)} / ${formatNumber(data.summary.total_files)} files processed`,
    stageLabel: "可視化準備",
  });
  await loadPlotly();
  updateProgress({
    percent: 90,
    title: "グラフを生成中...",
    description: "ツリーと拡張子グラフを描画しています。",
    countLabel: `${formatNumber(data.summary.total_files)} / ${formatNumber(data.summary.total_files)} files processed`,
    stageLabel: "描画中",
  });
  await renderTreeChart(data.tree);
  await yieldToBrowser();
  renderExtensionChart(data.extensions);
  await yieldToBrowser();
  renderLargestFiles(data.largest_files);
  renderLargestDirs(data.largest_dirs);
  renderFilesSection();
  renderNotes(data.notes);
}

function populateExtensionFilter(extensions) {
  const current = extensionFilter.value;
  const options = [
    '<option value="">すべて</option>',
    ...extensions.map((item) => `<option value="${escapeHtml(item.extension)}">${escapeHtml(item.extension)}</option>`),
  ];
  extensionFilter.innerHTML = options.join("");
  if ([...extensionFilter.options].some((option) => option.value === current)) {
    extensionFilter.value = current;
  }
}

async function renderTreeChart(tree) {
  await loadPlotly();
  const flattened = flattenTree(tree);
  const trace = {
    type: state.chartMode,
    ids: flattened.ids,
    labels: flattened.labels,
    parents: flattened.parents,
    values: flattened.values,
    branchvalues: "total",
    textinfo: state.chartMode === "treemap" ? "label+value" : "label",
    hovertemplate: "<b>%{label}</b><br>Size: %{value:,.0f} bytes<extra></extra>",
    marker: {
      colorscale: [
        [0, "#f1d2bc"],
        [0.45, "#d98650"],
        [0.7, "#965530"],
        [1, "#4d4239"],
      ],
    },
    pathbar: { visible: state.chartMode === "sunburst" },
  };

  window.Plotly.react("tree-chart", [trace], {
    margin: { t: 10, r: 10, b: 10, l: 10 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Segoe UI Variable Display, Segoe UI, Yu Gothic UI, sans-serif", color: "#1f2523" },
  }, { responsive: true, displayModeBar: false });
}

function renderExtensionChart(extensions) {
  const top = extensions.slice(0, 12);
  window.Plotly.react("extension-chart", [{
    type: "bar",
    x: top.map((item) => item.extension),
    y: top.map((item) => item.size),
    customdata: top.map((item) => item.count),
    marker: {
      color: "#245852",
      line: { color: "#173633", width: 1.2 },
    },
    hovertemplate: "<b>%{x}</b><br>Size: %{y:,.0f} bytes<br>Count: %{customdata}<extra></extra>",
  }], {
    margin: { t: 10, r: 10, b: 60, l: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Segoe UI Variable Display, Segoe UI, Yu Gothic UI, sans-serif", color: "#1f2523" },
    xaxis: { tickangle: -30 },
    yaxis: { title: "Bytes" },
  }, { responsive: true, displayModeBar: false });
}

function renderLargestDirs(directories) {
  const body = document.getElementById("largest-dirs-body");
  body.innerHTML = directories.length
    ? directories.map((item) => `
      <tr>
        <td class="mono">${escapeHtml(item.path)}</td>
        <td>${formatBytes(item.size)}</td>
        <td>${formatNumber(item.file_count)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="3">表示できるフォルダがありません。</td></tr>';
}

function renderLargestFiles(files) {
  const body = document.getElementById("largest-files-body");
  body.innerHTML = files.length
    ? files.map((item) => `
      <tr>
        <td class="mono">${escapeHtml(item.path)}</td>
        <td>${escapeHtml(item.extension)}</td>
        <td>${formatBytes(item.size)}</td>
        <td>${escapeHtml(formatDate(item.modified_at))}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="4">表示できるファイルがありません。</td></tr>';
}

function renderFilesSection() {
  const body = document.getElementById("files-body");
  const stats = document.getElementById("filtered-stats");
  const filtered = getFilteredFiles();
  const topFiles = [...filtered]
    .sort((left, right) => right.size - left.size)
    .slice(0, 200);

  const filteredSize = filtered.reduce((sum, item) => sum + item.size, 0);
  stats.textContent = `${formatNumber(filtered.length)} files / ${formatBytes(filteredSize)}`;

  body.innerHTML = topFiles.length
    ? topFiles.map((item) => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.extension)}</td>
        <td>${formatBytes(item.size)}</td>
        <td>${escapeHtml(formatDate(item.modified_at))}</td>
        <td class="mono">${escapeHtml(item.parent)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="5">条件に一致するファイルがありません。</td></tr>';
}

function renderNotes(notes) {
  const list = document.getElementById("error-list");
  list.innerHTML = notes.length
    ? notes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>特記事項はありません。</li>";
}

function getFilteredFiles() {
  if (!state.analysis) {
    return [];
  }

  const selectedExtension = extensionFilter.value;
  const minBytes = Number(minSizeFilter.value || 0) * 1024 * 1024;
  const keyword = searchFilter.value.trim().toLowerCase();

  return state.analysis.files.filter((item) => {
    const matchesExtension = !selectedExtension || item.extension === selectedExtension;
    const matchesSize = item.size >= minBytes;
    const matchesKeyword = !keyword || item.name.toLowerCase().includes(keyword);
    return matchesExtension && matchesSize && matchesKeyword;
  });
}

function flattenTree(tree) {
  const ids = [];
  const labels = [];
  const parents = [];
  const values = [];

  const visit = (node, parentId) => {
    ids.push(node.path);
    labels.push(node.name || node.path);
    parents.push(parentId);
    values.push(node.size || 0);
    node.children.forEach((child) => visit(child, node.path));
  };

  visit(tree, "");
  return { ids, labels, parents, values };
}

async function analyzeFiles(files, onProgress) {
  await yieldToBrowser();

  const rootName = getRootName(files);
  const totalFiles = files.length;
  const fileRows = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const relativePath = normalizeRelativePath(file.webkitRelativePath || file.name);
    const pathParts = relativePath.split("/").filter(Boolean);
    const name = pathParts[pathParts.length - 1] || file.name;
    const parent = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : rootName;
    const extension = getExtension(name);

    fileRows.push({
      path: relativePath,
      name,
      extension,
      size: file.size,
      modified_at: new Date(file.lastModified).toISOString(),
      parent,
    });

    if (shouldYield(index, totalFiles)) {
      const processed = index + 1;
      onProgress({
        percent: scaleProgress(processed / totalFiles, 0, 42),
        title: "ファイル情報を読み込み中...",
        description: "選択したファイルのパス、サイズ、更新日時を収集しています。",
        countLabel: `${formatNumber(processed)} / ${formatNumber(totalFiles)} files processed`,
        stageLabel: "フォルダ読み込み",
      });
      await yieldToBrowser();
    }
  }

  const tree = createNode(rootName, rootName);
  const directoryMap = new Map([[rootName, tree]]);
  const extensionMap = new Map();

  for (let index = 0; index < fileRows.length; index += 1) {
    const file = fileRows[index];
    addFileToTree(tree, directoryMap, file);

    const bucket = extensionMap.get(file.extension) || { extension: file.extension, count: 0, size: 0 };
    bucket.count += 1;
    bucket.size += file.size;
    extensionMap.set(file.extension, bucket);

    if (shouldYield(index, totalFiles)) {
      const processed = index + 1;
      onProgress({
        percent: scaleProgress(processed / totalFiles, 42, 78),
        title: "フォルダ構造を解析中...",
        description: "ディレクトリツリーと拡張子ごとの集計を作成しています。",
        countLabel: `${formatNumber(processed)} / ${formatNumber(totalFiles)} files processed`,
        stageLabel: "解析中",
      });
      await yieldToBrowser();
    }
  }

  finalizeNode(tree);

  const directories = [...directoryMap.values()]
    .filter((node) => node.path !== rootName)
    .map((node) => ({
      path: node.path,
      name: node.name,
      size: node.size,
      file_count: node.file_count,
    }))
    .sort((left, right) => right.size - left.size);

  const extensions = [...extensionMap.values()]
    .sort((left, right) => (right.size - left.size) || (right.count - left.count) || left.extension.localeCompare(right.extension));

  const largestFiles = [...fileRows]
    .sort((left, right) => right.size - left.size)
    .slice(0, 15);

  const notes = [
    "選択したフォルダ内のファイル情報をブラウザ上だけで解析しています。",
    "サーバー側にファイル内容そのものはアップロードされません。",
    "ファイル数が多いほど、一覧生成とグラフ描画に時間がかかります。",
  ];

  onProgress({
    percent: 80,
    title: "可視化準備中...",
    description: "集計結果をテーブルとグラフ向けの形式に整えています。",
    countLabel: `${formatNumber(totalFiles)} / ${formatNumber(totalFiles)} files processed`,
    stageLabel: "可視化準備",
  });
  await yieldToBrowser();

  return {
    summary: {
      root_path: rootName,
      total_size: tree.size,
      total_files: fileRows.length,
      total_dirs: directoryMap.size,
    },
    extensions,
    largest_files: largestFiles,
    largest_dirs: directories.slice(0, 15),
    tree,
    files: fileRows,
    notes,
  };
}

function addFileToTree(rootNode, directoryMap, file) {
  const segments = file.path.split("/").filter(Boolean);
  const directorySegments = segments.slice(0, -1);
  let currentPath = rootNode.path;
  let currentNode = rootNode;

  for (let index = 1; index < directorySegments.length; index += 1) {
    const segment = directorySegments[index];
    currentPath = `${currentPath}/${segment}`;

    if (!directoryMap.has(currentPath)) {
      const childNode = createNode(segment, currentPath);
      directoryMap.set(currentPath, childNode);
      currentNode.children.push(childNode);
    }

    currentNode = directoryMap.get(currentPath);
  }

  currentNode.children.push({
    name: file.name,
    path: file.path,
    size: file.size,
    file_count: 1,
    children: [],
  });
}

function finalizeNode(node) {
  if (!node.children.length) {
    return node;
  }

  let totalSize = 0;
  let totalFiles = 0;
  node.children.forEach((child) => {
    finalizeNode(child);
    totalSize += child.size || 0;
    totalFiles += child.children.length ? child.file_count : 1;
  });
  node.size = totalSize;
  node.file_count = totalFiles;
  return node;
}

function createNode(name, path) {
  return {
    name,
    path,
    size: 0,
    file_count: 0,
    children: [],
  };
}

function getRootName(files) {
  const first = files[0]?.webkitRelativePath || files[0]?.name || "Selected Folder";
  return normalizeRelativePath(first).split("/")[0] || "Selected Folder";
}

function normalizeRelativePath(value) {
  return String(value).replaceAll("\\", "/");
}

function getExtension(name) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "(no extension)";
}

function yieldToBrowser() {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function shouldYield(index, total) {
  if (total <= 40) {
    return true;
  }

  return index === total - 1 || index % 50 === 49;
}

function scaleProgress(ratio, start, end) {
  const safeRatio = Math.min(Math.max(ratio, 0), 1);
  return Math.round(start + ((end - start) * safeRatio));
}

function updateProgress({ percent, title, description, countLabel, stageLabel, visible = true }) {
  if (visible) {
    progressPanel.classList.remove("hidden");
  }

  const safePercent = Math.min(Math.max(Math.round(percent), 0), 100);
  progressTitle.textContent = title;
  progressDescription.textContent = description;
  progressPercentage.textContent = `${safePercent}%`;
  progressFill.style.width = `${safePercent}%`;
  progressCount.textContent = countLabel;
  progressStage.textContent = stageLabel;
  progressBar.setAttribute("aria-valuenow", String(safePercent));
}

function loadPlotly() {
  if (window.Plotly) {
    return Promise.resolve(window.Plotly);
  }

  if (state.plotlyPromise) {
    return state.plotlyPromise;
  }

  state.plotlyPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/plotly.js";
    script.async = true;
    script.onload = () => resolve(window.Plotly);
    script.onerror = () => reject(new Error("グラフライブラリの読み込みに失敗しました。ページを再読み込みして再試行してください。"));
    document.head.appendChild(script);
  });

  return state.plotlyPromise;
}

function setMessage(text, tone) {
  messageBox.textContent = text;
  messageBox.className = `message ${tone || ""}`.trim();
}

function toggleBusy(isBusy) {
  state.isBusy = isBusy;
  const button = document.getElementById("analyze-button");
  const modeButtons = document.querySelectorAll(".mode-button");

  button.disabled = isBusy;
  button.textContent = isBusy ? "解析中..." : "フォルダを解析";
  folderInput.disabled = isBusy;
  modeButtons.forEach((item) => {
    item.disabled = isBusy;
  });
}

function formatBytes(bytes) {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("ja-JP").format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
