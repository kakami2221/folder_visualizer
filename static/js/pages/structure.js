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

const MEGABYTE = 1024 * 1024;
const CACHE_LIMIT = 8;
const FILE_READ_CHUNK_SIZE = 1000;
const FILE_NODE_SHARE = 0.25;

const state = {
  directories: [],
  directoryByPath: new Map(),
  meta: null,
  currentPath: "",
  mode: "treemap",
  chartCache: new Map(),
  drawRequestId: 0,
  drawQueue: Promise.resolve(),
};

export function getStructureSettings() {
  return {
    maxDepth: Math.max(
      1,
      Math.min(
        30,
        Math.floor(Number(document.getElementById("max-depth")?.value) || 6),
      ),
    ),
    minSize: Math.round(Math.max(
      0,
      Number(document.getElementById("min-display-size")?.value) || 0,
    ) * MEGABYTE),
    maxNodes: Math.max(
      50,
      Math.min(
        10_000,
        Math.floor(Number(document.getElementById("max-nodes")?.value) || 1500),
      ),
    ),
    includeFiles: Boolean(
      document.getElementById("structure-include-files")?.checked,
    ),
    aggregateOthers: Boolean(
      document.getElementById("structure-aggregate-others")?.checked,
    ),
  };
}

function normalizeDirectory(item) {
  const path = String(item?.path || "").replaceAll("\\", "/");
  const pieces = path.split("/").filter(Boolean);
  return {
    ...item,
    path,
    name: String(item?.name || pieces.at(-1) || path || "ルート"),
    parentPath: String(
      item?.parentPath || pieces.slice(0, -1).join("/"),
    ),
    depth: Number.isFinite(Number(item?.depth))
      ? Number(item.depth)
      : Math.max(0, pieces.length - 1),
    size: Math.max(0, Number(item?.size) || 0),
    fileCount: Math.max(0, Number(item?.fileCount ?? item?.file_count) || 0),
    directFileCount: Math.max(
      0,
      Number(item?.directFileCount ?? item?.direct_file_count) || 0,
    ),
    directoryCount: Math.max(0, Number(item?.directoryCount) || 0),
  };
}

function createFallbackRoot() {
  const path = String(state.meta?.rootName || "Selected Folder");
  return normalizeDirectory({
    path,
    name: path,
    parentPath: "",
    depth: 0,
    size: Number(state.meta?.totalSize) || 0,
    fileCount: Number(state.meta?.totalFiles) || 0,
  });
}

function rootDirectory() {
  return state.directories.reduce((root, directory) => {
    if (!root) {
      return directory;
    }
    return directory.depth < root.depth
      || (
        directory.depth === root.depth
        && directory.path.length < root.path.length
      )
      ? directory
      : root;
  }, null) || createFallbackRoot();
}

function resolveInitialDirectory() {
  const root = rootDirectory();
  const raw = new URLSearchParams(window.location.search).get("directory");
  if (!raw || raw.length > 1000) {
    return root.path;
  }
  const normalized = raw.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (state.directoryByPath.has(normalized)) {
    return normalized;
  }
  const rooted = `${root.path}/${normalized}`;
  if (state.directoryByPath.has(rooted)) {
    return rooted;
  }
  showMessage(
    "page-message",
    "指定されたフォルダが解析結果にないため、ルートを表示します。",
    "warning",
  );
  return root.path;
}

function renderCurrentDirectory() {
  const current = state.directoryByPath.get(state.currentPath) || rootDirectory();
  state.currentPath = current.path;
  setText("current-directory-name", current.name);
  setText("current-directory-size", formatBytes(current.size));
  setText("current-directory-direct-files", formatNumber(current.directFileCount));
  setText("current-directory-child-count", formatNumber(current.directoryCount));

  const viewLink = document.getElementById("view-current-directory");
  if (viewLink) {
    viewLink.href = buildMainUrl({ directory: current.path });
    viewLink.title = `${current.path}のファイルをメインページで確認`;
  }

  const breadcrumbs = document.getElementById("structure-breadcrumbs");
  if (!breadcrumbs) {
    return;
  }
  const parts = current.path.split("/").filter(Boolean);
  const fragment = document.createDocumentFragment();
  let path = "";
  parts.forEach((part, index) => {
    path = path ? `${path}/${part}` : part;
    if (index > 0) {
      fragment.appendChild(createElement("span", {
        text: "›",
        className: "breadcrumb-separator",
        attributes: { "aria-hidden": "true" },
      }));
    }
    const isCurrent = index === parts.length - 1;
    const link = createElement("a", {
      href: `${window.location.pathname}?directory=${encodeURIComponent(path)}`,
      text: part,
      title: `${path}を表示`,
    });
    if (isCurrent) {
      link.setAttribute("aria-current", "page");
    }
    fragment.appendChild(link);
  });
  breadcrumbs.replaceChildren(fragment);
}

function compareCandidateQuality(left, right) {
  return (left.size - right.size)
    || (right.depth - left.depth)
    || -left.path.localeCompare(right.path, "ja");
}

function pushTopCandidate(heap, item, limit) {
  if (limit <= 0) {
    return;
  }
  const bubbleUp = (start) => {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidateQuality(heap[index], heap[parent]) >= 0) {
        break;
      }
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  };
  const sinkDown = () => {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let weakest = index;
      if (
        left < heap.length
        && compareCandidateQuality(heap[left], heap[weakest]) < 0
      ) {
        weakest = left;
      }
      if (
        right < heap.length
        && compareCandidateQuality(heap[right], heap[weakest]) < 0
      ) {
        weakest = right;
      }
      if (weakest === index) {
        return;
      }
      [heap[index], heap[weakest]] = [heap[weakest], heap[index]];
      index = weakest;
    }
  };

  if (heap.length < limit) {
    heap.push(item);
    bubbleUp(heap.length - 1);
  } else if (compareCandidateQuality(item, heap[0]) > 0) {
    heap[0] = item;
    sinkDown();
  }
}

function normalizeFileNode(item) {
  const path = String(item?.path || item?.relativePath || item?.name || "")
    .replaceAll("\\", "/");
  return {
    id: Number(item?.id),
    type: "file",
    path,
    relativePath: String(item?.relativePath || path).replaceAll("\\", "/"),
    name: String(item?.name || path.split("/").at(-1) || "ファイル"),
    parentPath: String(item?.parentPath || ""),
    depth: Math.max(1, Number(item?.depth) || 1),
    size: Math.max(0, Number(item?.size) || 0),
  };
}

export function calculateStructureNodeBudget(
  settings,
  directoryCandidateCount,
  fileCandidateCount,
) {
  const maximumNodes = Math.max(1, Math.floor(Number(settings.maxNodes) || 1));
  const directories = Math.max(0, Math.floor(Number(directoryCandidateCount) || 0));
  const files = settings.includeFiles
    ? Math.max(0, Math.floor(Number(fileCandidateCount) || 0))
    : 0;
  const exceedsNodeLimit = directories + files > maximumNodes - 1;
  const otherReserve = (
    settings.aggregateOthers
    && maximumNodes > 1
    && exceedsNodeLimit
  )
    ? Math.min(
      maximumNodes - 1,
      Math.max(1, Math.ceil(maximumNodes * 0.1)),
    )
    : 0;
  const contentCapacity = Math.max(0, maximumNodes - 1 - otherReserve);
  const fileQuota = files > 0
    ? Math.min(
      files,
      Math.max(1, Math.floor(contentCapacity * FILE_NODE_SHARE)),
    )
    : 0;
  let selectedDirectories = Math.min(
    directories,
    Math.max(0, contentCapacity - fileQuota),
  );
  let selectedFiles = Math.min(
    files,
    Math.max(0, contentCapacity - selectedDirectories),
  );
  let unfilled = contentCapacity - selectedDirectories - selectedFiles;
  if (unfilled > 0) {
    const extraDirectories = Math.min(
      directories - selectedDirectories,
      unfilled,
    );
    selectedDirectories += extraDirectories;
    unfilled -= extraDirectories;
  }
  if (unfilled > 0) {
    selectedFiles += Math.min(files - selectedFiles, unfilled);
  }
  return {
    maximumNodes,
    otherReserve,
    contentCapacity,
    selectedDirectories,
    selectedFiles,
  };
}

export function buildStructureChartData(
  settings = getStructureSettings(),
  fileCandidates = [],
  eligibleFileCount = fileCandidates.length,
) {
  const root = state.directoryByPath.get(state.currentPath) || rootDirectory();
  const descendantPrefix = `${root.path}/`;
  const candidates = state.directories.filter((directory) => (
    directory.path === root.path
    || directory.path.startsWith(descendantPrefix)
  ));
  const byPath = new Map(candidates.map((directory) => [directory.path, directory]));
  const heap = [];
  let withinDepthCount = 1;
  let eligibleCount = 1;
  candidates.forEach((directory) => {
    if (directory.path === root.path) {
      return;
    }
    if (directory.depth - root.depth > settings.maxDepth) {
      return;
    }
    withinDepthCount += 1;
    if (directory.size < settings.minSize) {
      return;
    }
    eligibleCount += 1;
    pushTopCandidate(heap, directory, settings.maxNodes - 1);
  });
  const ordered = heap.sort((left, right) => (
    (right.size - left.size)
    || (left.depth - right.depth)
    || left.path.localeCompare(right.path, "ja")
  ));

  const files = settings.includeFiles
    ? fileCandidates
      .map(normalizeFileNode)
      .filter((file) => (
        file.size >= settings.minSize
        && file.depth - root.depth <= settings.maxDepth
        && (
          file.parentPath === root.path
          || file.parentPath.startsWith(descendantPrefix)
        )
      ))
      .sort((left, right) => (
        (right.size - left.size)
        || left.path.localeCompare(right.path, "ja")
      ))
    : [];
  const budget = calculateStructureNodeBudget(
    settings,
    ordered.length,
    Math.max(files.length, Number(eligibleFileCount) || 0),
  );
  const selectedDirectoryRows = ordered.slice(
    0,
    budget.selectedDirectories,
  );
  const selectedFiles = files.slice(
    0,
    budget.selectedFiles,
  );

  const selectedDirectories = [root, ...selectedDirectoryRows];
  const selectedPaths = new Set(
    selectedDirectories.map((directory) => directory.path),
  );
  const nearestSelectedParent = (item) => {
    let parentPath = item.parentPath;
    const visited = new Set();
    while (
      parentPath
      && !selectedPaths.has(parentPath)
      && !visited.has(parentPath)
    ) {
      visited.add(parentPath);
      parentPath = byPath.get(parentPath)?.parentPath
        || parentPath.split("/").slice(0, -1).join("/");
    }
    return item.path === root.path ? "" : (parentPath || root.path);
  };

  const ids = [];
  const labels = [];
  const parents = [];
  const values = [];
  const customdata = [];
  const childTotals = new Map();
  selectedDirectories.forEach((directory) => {
    const parent = nearestSelectedParent(directory);
    ids.push(directory.path);
    labels.push(directory.name);
    parents.push(parent);
    values.push(directory.size);
    customdata.push([
      directory.path,
      directory.fileCount,
      directory.directFileCount,
      directory.directoryCount,
      "directory",
      directory.path,
    ]);
    if (parent) {
      childTotals.set(parent, (childTotals.get(parent) || 0) + directory.size);
    }
  });
  selectedFiles.forEach((file) => {
    const parent = nearestSelectedParent(file);
    ids.push(`file::${String(file.id)}::${file.path}`);
    labels.push(file.name);
    parents.push(parent);
    values.push(file.size);
    customdata.push([
      file.path,
      1,
      0,
      0,
      "file",
      file.relativePath,
    ]);
    if (parent) {
      childTotals.set(parent, (childTotals.get(parent) || 0) + file.size);
    }
  });

  let remainingSlots = settings.maxNodes - ids.length;
  let otherCount = 0;
  if (settings.aggregateOthers) selectedDirectories.forEach((directory) => {
    if (remainingSlots <= 0) {
      return;
    }
    const remainder = Math.max(
      0,
      directory.size - (childTotals.get(directory.path) || 0),
    );
    if (remainder <= 0) {
      return;
    }
    ids.push(`${directory.path}::__other__`);
    labels.push("その他");
    parents.push(directory.path);
    values.push(remainder);
    customdata.push(["", 0, 0, 0, "other", ""]);
    remainingSlots -= 1;
    otherCount += 1;
  });

  return {
    ids,
    labels,
    parents,
    values,
    customdata,
    pruned: (
      withinDepthCount !== candidates.length
      || eligibleCount !== withinDepthCount
      || selectedDirectories.length !== eligibleCount
      || (
        settings.includeFiles
        && Number(eligibleFileCount) > selectedFiles.length
      )
      || otherCount > 0
    ),
    totalCandidates: candidates.length,
    fileNodeCount: selectedFiles.length,
    eligibleFileCount: settings.includeFiles ? Number(eligibleFileCount) || 0 : 0,
  };
}

function chartCacheKey(settings) {
  return [
    state.currentPath,
    settings.maxDepth,
    settings.minSize,
    settings.maxNodes,
    settings.includeFiles ? "files" : "folders",
    settings.aggregateOthers ? "aggregate" : "omit",
  ].join(":");
}

function readCachedChartData(settings) {
  const key = chartCacheKey(settings);
  if (state.chartCache.has(key)) {
    const cached = state.chartCache.get(key);
    state.chartCache.delete(key);
    state.chartCache.set(key, cached);
    return cached;
  }
  return null;
}

function cacheChartData(settings, data) {
  const key = chartCacheKey(settings);
  state.chartCache.set(key, data);
  while (state.chartCache.size > CACHE_LIMIT) {
    state.chartCache.delete(state.chartCache.keys().next().value);
  }
  return data;
}

async function loadFileCandidates(settings, requestId) {
  if (!settings.includeFiles) {
    return { files: [], totalCount: 0 };
  }
  const current = state.directoryByPath.get(state.currentPath) || rootDirectory();
  const isCancelled = () => requestId !== state.drawRequestId;
  const limit = Math.max(0, settings.maxNodes - 1);
  const result = await measured(
    "structure file candidates",
    () => Storage.queryFileIds({
      directory: current.path,
      includeDescendants: true,
      minSize: settings.minSize,
      maxDepth: current.depth + settings.maxDepth,
      sortBy: "size",
      direction: "desc",
    }, {
      limit,
      isCancelled,
      onProgress: ({ processed, total, matched }) => {
        if (!isCancelled()) {
          showMessage(
            "structure-notice",
            `ファイル候補を走査中: ${formatNumber(processed)} / ${formatNumber(total || processed)}（一致 ${formatNumber(matched)}）`,
          );
        }
      },
    }),
  );
  if (result.cancelled || isCancelled()) {
    return null;
  }
  const files = [];
  for (let start = 0; start < result.ids.length; start += FILE_READ_CHUNK_SIZE) {
    if (isCancelled()) {
      return null;
    }
    const rows = await Storage.getFilesByIds(
      result.ids.slice(start, start + FILE_READ_CHUNK_SIZE),
    );
    files.push(...rows);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return { files, totalCount: result.totalCount };
}

function updateModeButtons(mode) {
  for (const [id, buttonMode] of [
    ["treemap-button", "treemap"],
    ["sunburst-button", "sunburst"],
  ]) {
    const button = document.getElementById(id);
    const active = mode === buttonMode;
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", String(active));
  }
}

function bindChartNavigation(chart) {
  if (typeof chart.removeAllListeners === "function") {
    chart.removeAllListeners("plotly_click");
  }
  chart.on?.("plotly_click", (event) => {
    const point = event?.points?.[0];
    const path = String(point?.customdata?.[0] || point?.id || "");
    const nodeType = String(point?.customdata?.[4] || "directory");
    if (nodeType === "file") {
      const relativePath = String(point?.customdata?.[5] || path);
      if (relativePath) {
        window.location.assign(buildMainUrl({ path: relativePath }));
      }
    } else if (
      nodeType === "directory"
      && path
      && state.directoryByPath.has(path)
    ) {
      window.location.assign(buildMainUrl({ directory: path }));
    }
  });
}

export async function drawStructure(mode = state.mode) {
  const normalizedMode = mode === "sunburst" ? "sunburst" : "treemap";
  const Plotly = await requirePlotly();
  const requestId = ++state.drawRequestId;
  const settings = getStructureSettings();
  let data = readCachedChartData(settings);
  if (!data) {
    const fileResult = await loadFileCandidates(settings, requestId);
    if (!fileResult || requestId !== state.drawRequestId) {
      return;
    }
    data = cacheChartData(
      settings,
      buildStructureChartData(
        settings,
        fileResult.files,
        fileResult.totalCount,
      ),
    );
  }
  state.mode = normalizedMode;
  updateModeButtons(normalizedMode);

  const notice = document.getElementById("structure-notice");
  if (notice) {
    notice.classList.remove("hidden");
    notice.textContent = data.pruned
      ? settings.aggregateOthers
        ? "表示負荷を抑えるため、小さい項目や表示範囲外の項目を「その他」にまとめています。"
        : "表示負荷を抑えるため、条件外または上限を超えた項目は表示していません。"
      : `${formatNumber(data.ids.length)}個のノードを表示しています。`;
    if (settings.includeFiles && data.fileNodeCount > 0) {
      notice.textContent += ` ファイルは上位${formatNumber(data.fileNodeCount)}件です。`;
    }
    notice.classList.toggle("warning", data.pruned);
  }

  const chart = document.getElementById("structure-chart");
  const queued = state.drawQueue.catch(() => {}).then(() => measured(
    normalizedMode === "sunburst" ? "sunburst render" : "treemap render",
    async () => {
      if (requestId !== state.drawRequestId || !chart) {
        return;
      }
      await Plotly.react(chart, [{
        type: normalizedMode,
        ids: data.ids,
        labels: data.labels,
        parents: data.parents,
        values: data.values,
        customdata: data.customdata,
        branchvalues: "total",
        textinfo: normalizedMode === "treemap" ? "label+value" : "label",
        hovertemplate: [
          "<b>%{label}</b>",
          "<br>容量: %{value:,.0f} bytes",
          "<br>ファイル数: %{customdata[1]:,.0f}",
          "<extra></extra>",
        ].join(""),
        marker: {
          colorscale: [
            [0, "#f1d2bc"],
            [0.45, "#d98650"],
            [0.7, "#965530"],
            [1, "#4d4239"],
          ],
        },
        ...(normalizedMode === "treemap"
          ? { pathbar: { visible: true } }
          : {}),
      }], {
        margin: { t: 10, r: 10, b: 10, l: 10 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#1f2523" },
      }, {
        responsive: true,
        displayModeBar: false,
      });
      bindChartNavigation(chart);
    },
  ));
  state.drawQueue = queued;
  await queued;
}

function bindEvents() {
  document.getElementById("treemap-button")?.addEventListener("click", () => {
    void drawStructure("treemap").catch(showStructureError);
  });
  document.getElementById("sunburst-button")?.addEventListener("click", () => {
    void drawStructure("sunburst").catch(showStructureError);
  });
  document.getElementById("structure-controls")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void drawStructure(state.mode).catch(showStructureError);
  });
}

function showStructureError(error) {
  showMessage(
    "page-message",
    error?.message || "フォルダ構造を表示できませんでした。",
    "error",
  );
}

export async function initializeStructurePage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  state.meta = status.meta || await Storage.getCompleteMeta();
  state.directories = (await Storage.getDirectories()).map(normalizeDirectory);
  if (!state.directories.length) {
    state.directories = [createFallbackRoot()];
  }
  state.directoryByPath = new Map(
    state.directories.map((directory) => [directory.path, directory]),
  );
  state.currentPath = resolveInitialDirectory();
  renderCurrentDirectory();
  bindEvents();
  await drawStructure("treemap");
  if (!document.getElementById("page-message")?.textContent) {
    showMessage(
      "page-message",
      "グラフのフォルダを選ぶと、該当ファイルをメインページで確認できます。",
    );
  }
}

initializeWhenReady(initializeStructurePage);
