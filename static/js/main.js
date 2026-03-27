const state = {
  analysis: null,
  chartMode: "treemap",
};

const form = document.getElementById("analyze-form");
const folderInput = document.getElementById("folder-input");
const messageBox = document.getElementById("form-message");
const dashboard = document.getElementById("dashboard");
const extensionFilter = document.getElementById("extension-filter");
const minSizeFilter = document.getElementById("min-size-filter");
const searchFilter = document.getElementById("search-filter");

document.querySelectorAll("[data-chart-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.chartMode = button.dataset.chartMode;
    document.querySelectorAll("[data-chart-mode]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    if (state.analysis) {
      renderTreeChart(state.analysis.tree);
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

  const selectedFiles = [...folderInput.files];
  if (!selectedFiles.length) {
    setMessage("解析したいフォルダを選択してください。", "error");
    return;
  }

  setMessage("解析を実行しています。ファイル数が多い場合は時間がかかります。", "success");
  toggleBusy(true);

  try {
    const payload = await analyzeFiles(selectedFiles);
    state.analysis = payload;
    hydrateDashboard(payload);
    setMessage("解析が完了しました。", "success");
  } catch (error) {
    setMessage(error.message, "error");
    dashboard.classList.add("hidden");
  } finally {
    toggleBusy(false);
  }
});

function hydrateDashboard(data) {
  dashboard.classList.remove("hidden");

  document.getElementById("summary-size").textContent = formatBytes(data.summary.total_size);
  document.getElementById("summary-files").textContent = formatNumber(data.summary.total_files);
  document.getElementById("summary-dirs").textContent = formatNumber(data.summary.total_dirs);
  document.getElementById("summary-root").textContent = data.summary.root_path;

  populateExtensionFilter(data.extensions);
  renderTreeChart(data.tree);
  renderExtensionChart(data.extensions);
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

function renderTreeChart(tree) {
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

  Plotly.react("tree-chart", [trace], {
    margin: { t: 10, r: 10, b: 10, l: 10 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Segoe UI Variable Display, Segoe UI, Yu Gothic UI, sans-serif", color: "#1f2523" },
  }, { responsive: true, displayModeBar: false });
}

function renderExtensionChart(extensions) {
  const top = extensions.slice(0, 12);
  Plotly.react("extension-chart", [{
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

async function analyzeFiles(files) {
  await yieldToBrowser();

  const rootName = getRootName(files);
  const fileRows = files.map((file) => {
    const relativePath = normalizeRelativePath(file.webkitRelativePath || file.name);
    const pathParts = relativePath.split("/").filter(Boolean);
    const name = pathParts[pathParts.length - 1] || file.name;
    const parent = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : rootName;
    const extension = getExtension(name);

    return {
      path: relativePath,
      name,
      extension,
      size: file.size,
      modified_at: new Date(file.lastModified).toISOString(),
      parent,
    };
  });

  const tree = createNode(rootName, rootName);
  const directoryMap = new Map([[rootName, tree]]);
  const extensionMap = new Map();

  for (const file of fileRows) {
    addFileToTree(tree, directoryMap, file);

    const bucket = extensionMap.get(file.extension) || { extension: file.extension, count: 0, size: 0 };
    bucket.count += 1;
    bucket.size += file.size;
    extensionMap.set(file.extension, bucket);
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
    "ブラウザ API の制約により、表示されるのは選択したフォルダ配下の相対パスです。絶対パスは取得できません。",
    "解析対象はブラウザが列挙したファイルのみです。未選択フォルダや OS 保護領域は含まれません。",
    "ファイル内容は読み込まず、メタデータのみを使って集計しています。",
  ];

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
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function setMessage(text, tone) {
  messageBox.textContent = text;
  messageBox.className = `message ${tone || ""}`.trim();
}

function toggleBusy(isBusy) {
  const button = document.getElementById("analyze-button");
  button.disabled = isBusy;
  button.textContent = isBusy ? "解析中..." : "解析開始";
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
