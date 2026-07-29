import { CLEANUP_FLAGS } from "../common/constants.js";
import { ClientVirtualList } from "../table/client-virtual-list.js";
import {
  Storage,
  byId,
  createElement,
  ensureAnalysis,
  forEachCurrentFile,
  formatBytes,
  formatNumber,
  initializeWhenReady,
  setText,
  showMessage,
} from "./page-utils.js";

const MEGABYTE = 1024 * 1024;
const TYPE_LABELS = Object.freeze({
  "old-large": "古くて大きい",
  "zero-byte": "0バイト",
  temporary: "一時ファイル候補",
  backup: "バックアップ候補",
  log: "ログファイル",
  "no-extension": "拡張子なし",
  "long-path": "長すぎるパス",
  deep: "深すぎる階層",
  "same-name": "同名ファイル候補",
  build: "ビルド生成物",
  cache: "キャッシュ",
  "very-large": "非常に大きい単一ファイル",
  "concentrated-directory": "ファイルが集中しているフォルダ",
});

const state = {
  meta: null,
  candidates: [],
  filtered: [],
  selected: new Map(),
  list: null,
  scanToken: 0,
  candidateContext: null,
};

function thresholds() {
  return {
    ageDays: Math.max(1, Number(byId("cleanup-age-days")?.value) || 365),
    minSize: Math.max(0, Number(byId("cleanup-min-size")?.value) || 100) * MEGABYTE,
    maxDepth: Math.max(1, Number(byId("cleanup-max-depth")?.value) || 10),
    maxPath: Math.max(20, Number(byId("cleanup-max-path")?.value) || 180),
    category: String(byId("cleanup-category")?.value || ""),
  };
}

function sameNameSizeKey(file) {
  const nameLower = String(file.nameLower || file.name || "").toLowerCase();
  const size = Number(file.size);
  return `${nameLower}\u0000${Number.isFinite(size) && size >= 0 ? size : 0}`;
}

function createCandidateContext(meta, duplicateCandidates, directories) {
  const duplicateFileIds = new Set();
  const duplicateGroupKeys = new Set();
  for (const candidate of duplicateCandidates || []) {
    if (candidate.mode && candidate.mode !== "same-name-size") {
      continue;
    }
    const groupKey = String(candidate.groupKey || "");
    if (groupKey) {
      duplicateGroupKeys.add(groupKey);
    }
    for (const member of candidate.members || []) {
      if (member.id !== null && member.id !== undefined) {
        duplicateFileIds.add(String(member.id));
      }
      duplicateGroupKeys.add(sameNameSizeKey(member));
    }
  }

  const rootName = String(meta?.rootName || "");
  const totalFiles = Math.max(0, Number(meta?.totalFiles) || 0);
  const concentratedDirectoryPaths = new Set();
  for (const directory of directories || []) {
    const path = String(directory.path || "");
    const directFileCount = Math.max(0, Number(directory.directFileCount) || 0);
    if (
      path
      && path !== rootName
      && (
        directFileCount >= 1000
        || (
          totalFiles >= 100
          && directFileCount / totalFiles >= 0.25
        )
      )
    ) {
      concentratedDirectoryPaths.add(path);
    }
  }

  return {
    duplicateFileIds,
    duplicateGroupKeys,
    concentratedDirectoryPaths,
  };
}

function classify(file, rules, cutoff, context = null) {
  const types = [];
  const path = String(file.relativePath || file.path || "");
  const pathLower = path.toLowerCase();
  const nameLower = String(file.nameLower || file.name || "").toLowerCase();
  const extension = String(file.extension || "").toLowerCase();
  const mask = Number(file.cleanupMask) || 0;
  if (Number(file.size) >= rules.minSize && Number(file.lastModified) > 0 && Number(file.lastModified) < cutoff) {
    types.push("old-large");
  }
  if (Number(file.size) === 0) {
    types.push("zero-byte");
  }
  if (
    (mask & CLEANUP_FLAGS.TEMPORARY)
    || /(^|[._~-])(tmp|temp)([._~-]|$)/iu.test(nameLower)
    || [".tmp", ".temp", ".swp", ".part"].includes(extension)
  ) {
    types.push("temporary");
  }
  if (
    (mask & CLEANUP_FLAGS.BACKUP)
    || /\.(bak|backup|old|orig)$/iu.test(nameLower)
    || /(^|[/\\])backups?([/\\]|$)/iu.test(pathLower)
  ) {
    types.push("backup");
  }
  if ((mask & CLEANUP_FLAGS.LOG) || extension === ".log" || /(^|[/\\])logs?([/\\]|$)/iu.test(pathLower)) {
    types.push("log");
  }
  if (
    !extension
    || extension === "(no extension)"
    || (mask & CLEANUP_FLAGS.NO_EXTENSION)
  ) {
    types.push("no-extension");
  }
  if (path.length > rules.maxPath) {
    types.push("long-path");
  }
  if (Number(file.depth) > rules.maxDepth) {
    types.push("deep");
  }
  if (
    context?.duplicateFileIds?.has(String(file.id))
    || context?.duplicateGroupKeys?.has(sameNameSizeKey(file))
  ) {
    types.push("same-name");
  }
  if (
    (mask & CLEANUP_FLAGS.BUILD_ARTIFACT)
    || /(^|\/)(dist|build|target|out|coverage)(\/|$)/iu.test(pathLower)
  ) {
    types.push("build");
  }
  if (
    (mask & CLEANUP_FLAGS.CACHE)
    || /(^|\/)(\.?cache|__pycache__|node_modules)(\/|$)/iu.test(pathLower)
  ) {
    types.push("cache");
  }
  if ((mask & CLEANUP_FLAGS.VERY_LARGE) || Number(file.size) >= 1024 * MEGABYTE) {
    types.push("very-large");
  }
  if (
    context?.concentratedDirectoryPaths?.has(String(file.parentPath || ""))
  ) {
    types.push("concentrated-directory");
  }
  return [...new Set(types)];
}

function slimCandidate(file, types) {
  return {
    id: file.id,
    name: String(file.name || ""),
    path: String(file.relativePath || file.path || file.name || ""),
    parentPath: String(file.parentPath || ""),
    extension: String(file.extension || ""),
    size: Number(file.size) || 0,
    types,
  };
}

function renderRow(item) {
  const checkbox = createElement("input", {
    type: "checkbox",
    attributes: {
      "aria-label": `${item.path}を容量削減シミュレーターへ追加`,
    },
    dataset: { cleanupId: item.id },
  });
  checkbox.checked = state.selected.has(String(item.id));
  const name = createElement("div", { className: "truncate", text: item.name, title: item.path });
  const type = createElement("div", {
    className: "truncate",
    text: item.types.map((key) => TYPE_LABELS[key] || key).join(" / "),
    title: item.types.map((key) => TYPE_LABELS[key] || key).join(" / "),
  });
  const size = createElement("div", { text: formatBytes(item.size) });
  const path = createElement("div", { className: "truncate mono", text: item.parentPath || "-", title: item.parentPath });
  return createElement("div", {
    className: "cleanup-row",
    attributes: { role: "row" },
  }, [checkbox, name, type, size, path]);
}

function aggregateSelection(field, labels = null) {
  const totals = new Map();
  for (const item of state.selected.values()) {
    const keys = field === "types" ? item.types : [item[field] || "(なし)"];
    keys.forEach((key) => {
      const current = totals.get(key) || { count: 0, size: 0 };
      current.count += 1;
      current.size += item.size;
      totals.set(key, current);
    });
  }
  return [...totals.entries()]
    .map(([key, value]) => ({ key, label: labels?.[key] || key || "(なし)", ...value }))
    .sort((left, right) => right.size - left.size)
    .slice(0, 10);
}

function renderBreakdown(id, rows) {
  const target = byId(id);
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  if (!rows.length) {
    fragment.appendChild(createElement("li", {}, [
      createElement("span", { text: "選択なし" }),
      createElement("strong", { text: "0 B" }),
    ]));
  } else {
    rows.forEach((row) => {
      fragment.appendChild(createElement("li", {}, [
        createElement("span", {
          text: `${row.label}（${formatNumber(row.count)}件）`,
          title: row.label,
        }),
        createElement("strong", { text: formatBytes(row.size) }),
      ]));
    });
  }
  target.replaceChildren(fragment);
}

function updateSimulation() {
  let selectedSize = 0;
  state.selected.forEach((item) => {
    selectedSize += item.size;
  });
  const currentSize = Number(state.meta?.totalSize) || 0;
  const remaining = Math.max(0, currentSize - selectedSize);
  const rate = currentSize > 0 ? selectedSize / currentSize * 100 : 0;
  setText("sim-selected-count", formatNumber(state.selected.size));
  setText("sim-selected-size", formatBytes(selectedSize));
  setText("sim-current-size", formatBytes(currentSize));
  setText("sim-remaining-size", formatBytes(remaining));
  setText("sim-reduction-rate", `${rate.toFixed(rate >= 10 ? 1 : 2)}%`);
  renderBreakdown("sim-category-breakdown", aggregateSelection("types", TYPE_LABELS));
  renderBreakdown("sim-extension-breakdown", aggregateSelection("extension"));
  renderBreakdown("sim-directory-breakdown", aggregateSelection("parentPath"));
}

function applyCategoryFilter() {
  const category = thresholds().category;
  state.filtered = category
    ? state.candidates.filter((item) => item.types.includes(category))
    : state.candidates;
  state.list.setItems(state.filtered);
  setText(
    "cleanup-stats",
    `${formatNumber(state.filtered.length)}件 / ${formatBytes(state.filtered.reduce((sum, item) => sum + item.size, 0))}`,
  );
}

async function scanCandidates() {
  const rules = thresholds();
  const cutoff = Date.now() - rules.ageDays * 24 * 60 * 60 * 1000;
  const token = ++state.scanToken;
  const candidates = [];
  setText("cleanup-stats", "候補を検索中...");
  await forEachCurrentFile((rows, start, total) => {
    if (token !== state.scanToken) {
      return;
    }
    rows.forEach((file) => {
      const types = classify(file, rules, cutoff, state.candidateContext);
      if (types.length) {
        candidates.push(slimCandidate(file, types));
      }
    });
    setText(
      "cleanup-stats",
      `候補を検索中: ${formatNumber(Math.min(start + rows.length, total))} / ${formatNumber(total)}`,
    );
  }, {
    chunkSize: 1500,
    isCancelled: () => token !== state.scanToken,
  });
  if (token !== state.scanToken) {
    return;
  }
  state.candidates = candidates.sort((left, right) => right.size - left.size);
  await Storage.saveCleanupRules([{
    id: "default",
    enabled: true,
    ageDays: rules.ageDays,
    minSize: rules.minSize,
    maxDepth: rules.maxDepth,
    maxPath: rules.maxPath,
  }]);
  applyCategoryFilter();
}

function bindEvents() {
  byId("cleanup-controls")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void scanCandidates().catch((error) => {
      showMessage("page-message", error.message || "整理候補を検索できませんでした。", "error");
    });
  });
  byId("cleanup-category")?.addEventListener("change", applyCategoryFilter);
  byId("cleanup-list-rows")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-cleanup-id]");
    if (!checkbox) {
      return;
    }
    const item = state.candidates.find((candidate) => String(candidate.id) === checkbox.dataset.cleanupId);
    if (!item) {
      return;
    }
    if (checkbox.checked) {
      state.selected.set(String(item.id), item);
    } else {
      state.selected.delete(String(item.id));
    }
    updateSimulation();
  });
  byId("clear-cleanup-selection")?.addEventListener("click", () => {
    state.selected.clear();
    state.list.render();
    updateSimulation();
  });
  byId("select-visible-cleanup")?.addEventListener("click", () => {
    state.filtered.forEach((item) => state.selected.set(String(item.id), item));
    state.list.render();
    updateSimulation();
  });
}

async function initialize() {
  const status = await ensureAnalysis();
  if (!status.available) {
    return;
  }
  state.meta = status.meta;
  state.list = new ClientVirtualList({
    viewport: "cleanup-list-viewport",
    spacer: "cleanup-list-spacer",
    rows: "cleanup-list-rows",
    rowHeight: 72,
    renderRow,
  });
  const settings = await Storage.getSettings();
  byId("cleanup-age-days").value = String(settings.oldFileDays || 365);
  byId("cleanup-min-size").value = String(settings.largeFileMb || 100);
  byId("cleanup-max-depth").value = String(settings.deepPathDepth || 10);
  byId("cleanup-max-path").value = String(settings.longPathLength || 180);
  const [duplicateCandidates, directories] = await Promise.all([
    Storage.getDuplicateCandidates("same-name-size"),
    Storage.getDirectories(),
  ]);
  state.candidateContext = createCandidateContext(
    state.meta,
    duplicateCandidates,
    directories,
  );
  bindEvents();
  updateSimulation();
  await scanCandidates();
}

initializeWhenReady(initialize);

export {
  classify,
  createCandidateContext,
  sameNameSizeKey,
  TYPE_LABELS,
};
