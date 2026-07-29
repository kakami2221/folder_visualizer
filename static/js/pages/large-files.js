import {
  Storage,
  buildMainUrl,
  createElement,
  debounce,
  ensureAnalysis,
  formatBytes,
  formatDate,
  formatNumber,
  initializeWhenReady,
  setText,
  showMessage,
} from "./page-utils.js";

const MEGABYTE = 1024 * 1024;
const state = { files: [] };

export function getLargeFileControls() {
  const limit = Math.max(
    1,
    Math.min(
      5000,
      Math.floor(Number(document.getElementById("large-files-limit")?.value) || 100),
    ),
  );
  const minimumMegabytes = Math.max(
    0,
    Number(document.getElementById("min-file-size")?.value) || 0,
  );
  return {
    limit,
    minSize: Math.round(minimumMegabytes * MEGABYTE),
    sortBy: document.getElementById("large-files-sort")?.value === "lastModified"
      ? "lastModified"
      : "size",
    direction: document.getElementById("large-files-direction")?.value === "asc"
      ? "asc"
      : "desc",
  };
}

function modifiedTime(file) {
  return Number(file.lastModified ?? file.modifiedAt ?? file.modified_at) || 0;
}

export function visibleLargeFiles() {
  const controls = getLargeFileControls();
  const direction = controls.direction === "asc" ? 1 : -1;
  return [...state.files]
    .filter((file) => (Number(file.size) || 0) >= controls.minSize)
    .sort((left, right) => {
      const leftValue = controls.sortBy === "lastModified"
        ? modifiedTime(left)
        : Number(left.size) || 0;
      const rightValue = controls.sortBy === "lastModified"
        ? modifiedTime(right)
        : Number(right.size) || 0;
      return ((leftValue - rightValue) * direction)
        || String(left.relativePath || left.path || "").localeCompare(
          String(right.relativePath || right.path || ""),
          "ja",
        );
    })
    .slice(0, controls.limit);
}

function textCell(text, options = {}) {
  return createElement("td", {
    text,
    className: options.className || "",
    title: options.title || "",
  });
}

function linkCell(href, label, title) {
  const cell = document.createElement("td");
  cell.appendChild(createElement("a", { href, text: label, title }));
  return cell;
}

export function renderLargeFiles() {
  const body = document.getElementById("large-files-body");
  if (!body) {
    return;
  }
  const files = visibleLargeFiles();
  const fragment = document.createDocumentFragment();
  let visibleSize = 0;
  files.forEach((file) => {
    visibleSize += Number(file.size) || 0;
    const row = document.createElement("tr");
    const relativePath = String(file.relativePath || file.path || file.name || "-");
    const name = String(file.name || relativePath);
    row.append(
      textCell(name, { className: "truncate-cell", title: name }),
      textCell(relativePath, { className: "mono truncate-cell", title: relativePath }),
      textCell(file.extension && file.extension !== "(no extension)"
        ? file.extension
        : "(拡張子なし)"),
      textCell(formatBytes(file.size)),
      textCell(formatDate(modifiedTime(file))),
      linkCell(
        buildMainUrl({ path: relativePath }),
        "一覧で見る",
        `${name}をメインのファイル一覧で確認`,
      ),
    );
    fragment.appendChild(row);
  });
  if (!files.length) {
    const row = document.createElement("tr");
    row.appendChild(createElement("td", {
      text: "指定した条件に一致するファイルがありません。",
      attributes: { colspan: "6" },
    }));
    fragment.appendChild(row);
  }
  body.replaceChildren(fragment);

  const matchingCount = state.files.filter(
    (file) => (Number(file.size) || 0) >= getLargeFileControls().minSize,
  ).length;
  const suffix = matchingCount > files.length
    ? `（条件一致 ${formatNumber(matchingCount)}件）`
    : "";
  setText(
    "large-files-stats",
    `${formatNumber(files.length)} files / ${formatBytes(visibleSize)} ${suffix}`.trim(),
  );
}

export async function initializeLargeFilesPage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  state.files = await Storage.getLargestFiles();
  ["large-files-limit", "large-files-sort", "large-files-direction"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", renderLargeFiles);
  });
  document.getElementById("min-file-size")?.addEventListener(
    "input",
    debounce(renderLargeFiles, 250),
  );
  renderLargeFiles();
  showMessage("page-message", "「一覧で見る」から、対象ファイルをメインページで確認できます。");
}

initializeWhenReady(initializeLargeFilesPage);

