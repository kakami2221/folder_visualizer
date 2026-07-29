(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common;
  const Storage = app.Storage || app.storage;
  const MEGABYTE = 1024 * 1024;
  const CACHE_LIMIT = 8;

  const state = {
    directories: [],
    meta: null,
    mode: "treemap",
    chartCache: new Map(),
    drawRequestId: 0,
    drawQueue: Promise.resolve(),
  };

  function getSettings() {
    const maxDepth = Math.max(
      0,
      Math.min(50, Math.floor(Number(document.getElementById("max-depth")?.value) || 6)),
    );
    const minimumMegabytes = Math.max(
      0,
      Number(document.getElementById("min-display-size")?.value) || 0,
    );
    const maxNodes = Math.max(
      1,
      Math.min(10000, Math.floor(Number(document.getElementById("max-nodes")?.value) || 1500)),
    );
    return {
      maxDepth,
      minSize: Math.round(minimumMegabytes * MEGABYTE),
      maxNodes,
    };
  }

  function normalizeDirectory(item) {
    const path = String(item?.path || "");
    const pieces = path.split("/").filter(Boolean);
    return {
      path,
      name: item?.name || pieces.at(-1) || path || state.meta?.rootName || "ルート",
      parentPath: item?.parentPath || pieces.slice(0, -1).join("/"),
      depth: Number.isFinite(Number(item?.depth))
        ? Number(item.depth)
        : Math.max(0, pieces.length - 1),
      size: Math.max(0, Number(item?.size) || 0),
      fileCount: Math.max(0, Number(item?.fileCount ?? item?.file_count) || 0),
    };
  }

  function createFallbackRoot() {
    return {
      path: state.meta?.rootName || "Selected Folder",
      name: state.meta?.rootName || "Selected Folder",
      parentPath: "",
      depth: 0,
      size: Number(state.meta?.totalSize) || 0,
      fileCount: Number(state.meta?.totalFiles) || 0,
    };
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
        const left = (index * 2) + 1;
        const right = left + 1;
        let worst = index;
        if (
          left < heap.length
          && compareCandidateQuality(heap[left], heap[worst]) < 0
        ) {
          worst = left;
        }
        if (
          right < heap.length
          && compareCandidateQuality(heap[right], heap[worst]) < 0
        ) {
          worst = right;
        }
        if (worst === index) {
          break;
        }
        [heap[index], heap[worst]] = [heap[worst], heap[index]];
        index = worst;
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

  function buildChartData(settings) {
    const byPath = new Map();
    let root = null;
    for (const rawDirectory of state.directories) {
      const item = normalizeDirectory(rawDirectory);
      byPath.set(item.path, item);
      if (
        !root
        || item.depth < root.depth
        || (item.depth === root.depth && item.path.length < root.path.length)
      ) {
        root = item;
      }
    }
    if (!root) {
      root = createFallbackRoot();
      byPath.set(root.path, root);
    }

    const rootDepth = root.depth;
    const topCandidates = [];
    let withinDepthCount = 1;
    let eligibleCount = 1;
    for (const item of byPath.values()) {
      if (item.path === root.path) {
        continue;
      }
      if (item.depth - rootDepth > settings.maxDepth) {
        continue;
      }
      withinDepthCount += 1;
      if (item.size < settings.minSize) {
        continue;
      }
      eligibleCount += 1;
      pushTopCandidate(topCandidates, item, settings.maxNodes - 1);
    }
    const ordered = topCandidates
      .sort((left, right) => (
        (right.size - left.size)
        || (left.depth - right.depth)
        || left.path.localeCompare(right.path, "ja")
      ));

    const needsLimit = eligibleCount > settings.maxNodes;
    const otherReserve = needsLimit && settings.maxNodes > 1
      ? Math.min(
        settings.maxNodes - 1,
        Math.max(1, Math.ceil(settings.maxNodes * 0.1)),
      )
      : 0;
    const directoryLimit = Math.max(1, settings.maxNodes - otherReserve);
    const selected = [root, ...ordered.slice(0, directoryLimit - 1)];
    const selectedPaths = new Set(selected.map((item) => item.path));

    const nearestSelectedParent = (item) => {
      let parentPath = item.parentPath;
      const visited = new Set();
      while (parentPath && !selectedPaths.has(parentPath) && !visited.has(parentPath)) {
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

    selected.forEach((item) => {
      const parent = nearestSelectedParent(item);
      ids.push(item.path);
      labels.push(item.name);
      parents.push(parent);
      values.push(item.size);
      customdata.push(item.fileCount);
      if (parent) {
        childTotals.set(parent, (childTotals.get(parent) || 0) + item.size);
      }
    });

    let remainingSlots = settings.maxNodes - ids.length;
    let otherCount = 0;
    if (remainingSlots > 0) {
      for (const item of selected) {
        if (remainingSlots <= 0) {
          break;
        }
        const remainder = Math.max(0, item.size - (childTotals.get(item.path) || 0));
        if (!remainder) {
          continue;
        }
        ids.push(`${item.path}::__other__`);
        labels.push("その他");
        parents.push(item.path);
        values.push(remainder);
        customdata.push(null);
        otherCount += 1;
        remainingSlots -= 1;
      }
    }

    const excludedByDepth = withinDepthCount !== byPath.size;
    const excludedByMinimum = eligibleCount !== withinDepthCount;
    const excludedByLimit = selected.length !== eligibleCount;
    return {
      ids,
      labels,
      parents,
      values,
      customdata,
      pruned: excludedByDepth || excludedByMinimum || excludedByLimit || otherCount > 0,
      otherCount,
      totalCandidates: byPath.size,
    };
  }

  function cacheKey(mode, settings) {
    return `${mode}:${settings.maxDepth}:${settings.minSize}:${settings.maxNodes}`;
  }

  function cachedChartData(mode, settings) {
    const key = cacheKey(mode, settings);
    if (state.chartCache.has(key)) {
      const cached = state.chartCache.get(key);
      state.chartCache.delete(key);
      state.chartCache.set(key, cached);
      return cached;
    }
    const data = buildChartData(settings);
    state.chartCache.set(key, data);
    while (state.chartCache.size > CACHE_LIMIT) {
      state.chartCache.delete(state.chartCache.keys().next().value);
    }
    return data;
  }

  function updateModeButtons(mode) {
    const treemap = document.getElementById("treemap-button");
    const sunburst = document.getElementById("sunburst-button");
    for (const [button, buttonMode] of [[treemap, "treemap"], [sunburst, "sunburst"]]) {
      const active = mode === buttonMode;
      button?.classList.toggle("active", active);
      button?.setAttribute("aria-pressed", String(active));
    }
  }

  async function draw(mode = state.mode) {
    if (!window.Plotly?.react) {
      throw new Error("Plotly.jsを読み込めませんでした。ページを再読み込みしてください。");
    }
    const requestId = ++state.drawRequestId;
    const settings = getSettings();
    const data = cachedChartData(mode, settings);
    state.mode = mode;
    updateModeButtons(mode);

    const notice = document.getElementById("structure-notice");
    if (notice) {
      notice.classList.remove("hidden");
      notice.textContent = data.pruned
        ? "表示負荷を抑えるため、階層・サイズ・件数の条件に応じて小さい項目を「その他」にまとめています。"
        : `${Common.formatNumber(data.ids.length)}個のフォルダノードを表示しています。`;
      notice.classList.toggle("warning", data.pruned);
    }

    const durationName = mode === "sunburst" ? "sunburst render" : "treemap render";
    const queuedDraw = state.drawQueue.catch(() => {}).then(() => (
      Common.measureAsync(durationName, async () => {
        if (requestId !== state.drawRequestId) {
          return;
        }
        const trace = {
          type: mode,
          ids: data.ids,
          labels: data.labels,
          parents: data.parents,
          values: data.values,
          customdata: data.customdata,
          branchvalues: "total",
          textinfo: mode === "treemap" ? "label+value" : "label",
          hovertemplate: "<b>%{label}</b><br>容量: %{value:,.0f} bytes<br>ファイル数: %{customdata}<extra></extra>",
          marker: {
            colorscale: [
              [0, "#f1d2bc"],
              [0.45, "#d98650"],
              [0.7, "#965530"],
              [1, "#4d4239"],
            ],
          },
          pathbar: { visible: mode === "treemap" },
        };
        await window.Plotly.react("structure-chart", [trace], {
          margin: { t: 10, r: 10, b: 10, l: 10 },
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          font: {
            family: "Segoe UI Variable Display, Segoe UI, Yu Gothic UI, sans-serif",
            color: "#1f2523",
          },
        }, {
          responsive: true,
          displayModeBar: false,
        });
      })
    ));
    state.drawQueue = queuedDraw;
    await queuedDraw;
  }

  function bindEvents() {
    document.getElementById("treemap-button")?.addEventListener("click", () => {
      void draw("treemap").catch(showError);
    });
    document.getElementById("sunburst-button")?.addEventListener("click", () => {
      void draw("sunburst").catch(showError);
    });
    document.getElementById("structure-controls")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void draw(state.mode).catch(showError);
    });
    document.getElementById("apply-structure-settings")?.addEventListener("click", (event) => {
      if (event.currentTarget.form?.id === "structure-controls") {
        return;
      }
      void draw(state.mode).catch(showError);
    });
  }

  function showError(error) {
    console.error("フォルダ構造を表示できませんでした。", error);
    Common.showMessage(
      "page-message",
      error?.message || "フォルダ構造を表示できませんでした。",
      "error",
    );
  }

  async function initialize() {
    try {
      const status = await Common.showAnalysisState();
      if (!status.available) {
        return;
      }
      state.meta = status.meta || await Storage.getCompleteMeta();
      state.directories = await Storage.getDirectories();
      bindEvents();
      await draw("treemap");
    } catch (error) {
      showError(error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });

  app.StructurePage = Object.freeze({
    buildChartData,
    draw,
    getSettings,
    getState: () => ({
      mode: state.mode,
      directoryCount: state.directories.length,
      chartCacheSize: state.chartCache.size,
    }),
  });
})();
