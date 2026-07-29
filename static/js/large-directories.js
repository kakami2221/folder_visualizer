(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common;
  const Storage = app.Storage || app.storage;

  const state = {
    directories: [],
  };

  function normalizeDirectories(result) {
    if (Array.isArray(result)) {
      return result;
    }
    const candidates = [
      ...(Array.isArray(result?.bySize) ? result.bySize : []),
      ...(Array.isArray(result?.byFileCount) ? result.byFileCount : []),
    ];
    const unique = new Map();
    candidates.forEach((item) => unique.set(item.path, item));
    return [...unique.values()];
  }

  function getControls() {
    const sortValue = document.getElementById("large-directories-sort")?.value;
    return {
      sortBy: ["fileCount", "averageSize"].includes(sortValue)
        ? sortValue
        : "size",
      limit: Math.max(
        1,
        Math.min(
          5000,
          Math.floor(Number(document.getElementById("large-directories-limit")?.value) || 100),
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
    return count ? (Number(directory.size) || 0) / count : 0;
  }

  function orderedDirectories() {
    const controls = getControls();
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

  function createCell(text, { className = "", title = "" } = {}) {
    const cell = document.createElement("td");
    if (className) {
      cell.className = className;
    }
    cell.textContent = text;
    if (title) {
      cell.title = title;
    }
    return cell;
  }

  function render() {
    const body = document.getElementById("large-directories-body");
    if (!body) {
      return;
    }
    const directories = orderedDirectories();
    const fragment = document.createDocumentFragment();
    for (const directory of directories) {
      const row = document.createElement("tr");
      const path = directory.path || directory.name || "-";
      row.append(
        createCell(path, { className: "mono truncate-cell", title: path }),
        createCell(Common.formatBytes(directory.size)),
        createCell(Common.formatNumber(directory.fileCount ?? directory.file_count)),
        createCell(Common.formatNumber(
          directory.directFileCount ?? directory.direct_file_count,
        )),
        createCell(Common.formatBytes(averageFileSize(directory))),
      );
      fragment.appendChild(row);
    }
    if (!directories.length) {
      const row = document.createElement("tr");
      const cell = createCell("表示できるフォルダ情報がありません。");
      cell.colSpan = 5;
      row.appendChild(cell);
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);
    const controls = getControls();
    const criterion = controls.sortBy === "fileCount"
      ? "ファイル数順"
      : controls.sortBy === "averageSize"
        ? "平均ファイルサイズ順"
        : "容量順";
    Common.setText(
      "large-directories-stats",
      `${criterion}・上位 ${Common.formatNumber(directories.length)} folders`,
    );
  }

  function showError(error) {
    console.error("大きいフォルダ一覧を表示できませんでした。", error);
    Common.showMessage(
      "page-message",
      error?.message || "大きいフォルダ一覧を表示できませんでした。",
      "error",
    );
  }

  async function initialize() {
    try {
      const status = await Common.showAnalysisState();
      if (!status.available) {
        return;
      }
      state.directories = normalizeDirectories(await Storage.getLargestDirectories());
      ["large-directories-sort", "large-directories-limit"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", render);
      });
      render();
    } catch (error) {
      showError(error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });

  app.LargeDirectoriesPage = Object.freeze({
    render,
    getControls,
    getState: () => ({ storedDirectoryCount: state.directories.length }),
  });
})();
