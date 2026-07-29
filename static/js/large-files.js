(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common;
  const Storage = app.Storage || app.storage;
  const MEGABYTE = 1024 * 1024;

  const state = {
    files: [],
  };

  function getControls() {
    const limit = Math.max(
      1,
      Math.min(5000, Math.floor(Number(document.getElementById("large-files-limit")?.value) || 100)),
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

  function visibleFiles() {
    const controls = getControls();
    const direction = controls.direction === "asc" ? 1 : -1;
    const files = state.files
      .filter((file) => (Number(file.size) || 0) >= controls.minSize)
      .sort((left, right) => {
        const leftValue = controls.sortBy === "lastModified"
          ? modifiedTime(left)
          : Number(left.size) || 0;
        const rightValue = controls.sortBy === "lastModified"
          ? modifiedTime(right)
          : Number(right.size) || 0;
        return ((leftValue - rightValue) * direction)
          || String(left.path).localeCompare(String(right.path), "ja");
      });
    return files.slice(0, controls.limit);
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
    const body = document.getElementById("large-files-body");
    if (!body) {
      return;
    }
    const files = visibleFiles();
    const fragment = document.createDocumentFragment();
    let visibleSize = 0;
    for (const file of files) {
      visibleSize += Number(file.size) || 0;
      const row = document.createElement("tr");
      const path = file.path || file.name || "-";
      row.append(
        createCell(file.name || path, {
          className: "truncate-cell",
          title: file.name || path,
        }),
        createCell(path, { className: "mono truncate-cell", title: path }),
        createCell(file.extension || "(拡張子なし)"),
        createCell(Common.formatBytes(file.size)),
        createCell(Common.formatDate(modifiedTime(file))),
      );
      fragment.appendChild(row);
    }
    if (!files.length) {
      const row = document.createElement("tr");
      const cell = createCell("指定した条件に一致するファイルがありません。");
      cell.colSpan = 5;
      row.appendChild(cell);
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);

    const matchingCount = state.files.filter(
      (file) => (Number(file.size) || 0) >= getControls().minSize,
    ).length;
    const suffix = matchingCount > files.length
      ? `（条件一致 ${Common.formatNumber(matchingCount)}件）`
      : "";
    Common.setText(
      "large-files-stats",
      `${Common.formatNumber(files.length)} files / ${Common.formatBytes(visibleSize)} ${suffix}`.trim(),
    );
  }

  function showError(error) {
    console.error("大きいファイル一覧を表示できませんでした。", error);
    Common.showMessage(
      "page-message",
      error?.message || "大きいファイル一覧を表示できませんでした。",
      "error",
    );
  }

  async function initialize() {
    try {
      const status = await Common.showAnalysisState();
      if (!status.available) {
        return;
      }
      state.files = await Storage.getLargestFiles();
      ["large-files-limit", "large-files-sort", "large-files-direction"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", render);
      });
      document.getElementById("min-file-size")?.addEventListener(
        "input",
        Common.debounce(render, 250),
      );
      render();
    } catch (error) {
      showError(error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });

  app.LargeFilesPage = Object.freeze({
    render,
    getControls,
    getState: () => ({ storedFileCount: state.files.length }),
  });
})();
