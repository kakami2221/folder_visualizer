import {
  Storage,
  buildMainUrl,
  createElement,
  ensureAnalysis,
  formatBytes,
  formatNumber,
  initializeWhenReady,
  setText,
  showMessage,
} from "./page-utils.js";

const state = { directories: [] };

export function getLargeDirectoryControls() {
  const sortValue = document.getElementById("large-directories-sort")?.value;
  return {
    sortBy: ["fileCount", "averageSize"].includes(sortValue)
      ? sortValue
      : "size",
    limit: Math.max(
      1,
      Math.min(
        5000,
        Math.floor(
          Number(document.getElementById("large-directories-limit")?.value) || 100,
        ),
      ),
    ),
  };
}

function averageFileSize(directory) {
  const provided = Number(directory.averageFileSize ?? directory.average_file_size);
  if (Number.isFinite(provided) && provided >= 0) {
    return provided;
  }
  const count = Number(directory.fileCount ?? directory.file_count) || 0;
  return count > 0 ? (Number(directory.size) || 0) / count : 0;
}

export function orderedLargeDirectories() {
  const controls = getLargeDirectoryControls();
  return [...state.directories]
    .sort((left, right) => {
      const leftValue = Number(
        controls.sortBy === "fileCount"
          ? left.fileCount ?? left.file_count
          : controls.sortBy === "averageSize"
            ? averageFileSize(left)
            : left.size,
      ) || 0;
      const rightValue = Number(
        controls.sortBy === "fileCount"
          ? right.fileCount ?? right.file_count
          : controls.sortBy === "averageSize"
            ? averageFileSize(right)
            : right.size,
      ) || 0;
      return (rightValue - leftValue)
        || ((Number(right.size) || 0) - (Number(left.size) || 0))
        || String(left.path).localeCompare(String(right.path), "ja");
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

export function renderLargeDirectories() {
  const body = document.getElementById("large-directories-body");
  if (!body) {
    return;
  }
  const directories = orderedLargeDirectories();
  const fragment = document.createDocumentFragment();
  directories.forEach((directory) => {
    const path = String(directory.path || directory.name || "-");
    const row = document.createElement("tr");
    const action = document.createElement("td");
    action.appendChild(createElement("a", {
      href: buildMainUrl({ directory: path }),
      text: "一覧で見る",
      title: `${path}のファイルをメインページで確認`,
    }));
    row.append(
      textCell(path, { className: "mono truncate-cell", title: path }),
      textCell(formatBytes(directory.size)),
      textCell(formatNumber(directory.fileCount ?? directory.file_count)),
      textCell(formatNumber(
        directory.directFileCount ?? directory.direct_file_count,
      )),
      textCell(formatBytes(averageFileSize(directory))),
      action,
    );
    fragment.appendChild(row);
  });
  if (!directories.length) {
    const row = document.createElement("tr");
    row.appendChild(createElement("td", {
      text: "表示できるフォルダ情報がありません。",
      attributes: { colspan: "6" },
    }));
    fragment.appendChild(row);
  }
  body.replaceChildren(fragment);

  const controls = getLargeDirectoryControls();
  const criterion = controls.sortBy === "fileCount"
    ? "ファイル数順"
    : controls.sortBy === "averageSize"
      ? "平均ファイルサイズ順"
      : "容量順";
  setText(
    "large-directories-stats",
    `${criterion}・上位 ${formatNumber(directories.length)} folders`,
  );
}

export async function initializeLargeDirectoriesPage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  state.directories = await Storage.getLargestDirectories();
  ["large-directories-sort", "large-directories-limit"].forEach((id) => {
    document.getElementById(id)?.addEventListener(
      "change",
      renderLargeDirectories,
    );
  });
  renderLargeDirectories();
  showMessage("page-message", "「一覧で見る」から、そのフォルダのファイルを確認できます。");
}

initializeWhenReady(initializeLargeDirectoriesPage);

