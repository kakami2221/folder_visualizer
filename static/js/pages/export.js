import {
  Storage,
  copyText,
  downloadBlob,
  ensureAnalysis,
  escapeHtml,
  escapeMarkdown,
  escapeMermaid,
  forEachCurrentFile,
  formatBytes,
  formatDate,
  formatNumber,
  initializeWhenReady,
  measured,
  queryFromUrl,
  safeCsvCell,
  sanitizeFileName,
  setText,
  showMessage,
} from "./page-utils.js";

const FILE_CHUNK_SIZE = 1000;
const LARGE_PREVIEW_CHARACTERS = 500_000;
const LARGE_STRUCTURE_ITEMS = 10_000;

const state = {
  meta: null,
  busy: false,
  structureOutput: "",
  structureFormat: "markdown",
};

function isoDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function rootFileName(suffix) {
  const root = sanitizeFileName(state.meta?.rootName, "folder-visualizer");
  return `${root}-${suffix}`;
}

export function csvLine(cells) {
  return `${cells.map((cell) => safeCsvCell(cell)).join(",")}\r\n`;
}

function fileCsvRow(file) {
  return csvLine([
    file.name,
    file.relativePath || file.path,
    file.parentPath,
    file.extension,
    file.category,
    Number(file.size) || 0,
    isoDate(file.lastModified),
    Number(file.depth) || 0,
  ]);
}

function setExportProgress(message, tone = "") {
  showMessage("export-progress", message, tone);
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("[data-export], #structure-export-form button").forEach(
    (button) => {
      button.disabled = busy;
    },
  );
}

async function exportFilesCsv(criteria, suffix) {
  const parts = [
    "\uFEFF",
    csvLine([
      "ファイル名",
      "相対パス",
      "親フォルダ",
      "拡張子",
      "カテゴリ",
      "サイズ(bytes)",
      "更新日時",
      "深さ",
    ]),
  ];
  let count = 0;
  await measured("CSV export", () => forEachCurrentFile(
    async (files, start, total) => {
      const rows = files.map(fileCsvRow);
      parts.push(rows.join(""));
      count += files.length;
      setExportProgress(
        `CSVを生成中: ${formatNumber(Math.min(start + files.length, total))} / ${formatNumber(total)}件`,
      );
    },
    { criteria, chunkSize: FILE_CHUNK_SIZE },
  ));
  downloadBlob(
    new Blob(parts, { type: "text/csv;charset=utf-8" }),
    rootFileName(suffix),
  );
  setExportProgress(`${formatNumber(count)}件のCSVを保存しました。`, "success");
}

function appendCsvRows(parts, rows, mapper) {
  for (let start = 0; start < rows.length; start += FILE_CHUNK_SIZE) {
    parts.push(
      rows.slice(start, start + FILE_CHUNK_SIZE).map(mapper).join(""),
    );
  }
}

async function exportExtensionsCsv() {
  const rows = await Storage.getExtensions();
  const parts = [
    "\uFEFF",
    csvLine(["拡張子", "カテゴリ", "合計容量(bytes)", "ファイル数", "平均サイズ(bytes)"]),
  ];
  appendCsvRows(parts, rows, (row) => csvLine([
    row.extension,
    row.category,
    Number(row.size) || 0,
    Number(row.count) || 0,
    Number(row.count) > 0 ? (Number(row.size) || 0) / Number(row.count) : 0,
  ]));
  downloadBlob(
    new Blob(parts, { type: "text/csv;charset=utf-8" }),
    rootFileName("extensions.csv"),
  );
  setExportProgress("拡張子集計CSVを保存しました。", "success");
}

async function exportDirectoriesCsv() {
  const rows = await Storage.getDirectories();
  const parts = [
    "\uFEFF",
    csvLine([
      "フォルダ",
      "親フォルダ",
      "深さ",
      "合計容量(bytes)",
      "ファイル数",
      "直下ファイル数",
      "子フォルダ数",
    ]),
  ];
  appendCsvRows(parts, rows, (row) => csvLine([
    row.path,
    row.parentPath,
    Number(row.depth) || 0,
    Number(row.size) || 0,
    Number(row.fileCount) || 0,
    Number(row.directFileCount) || 0,
    Number(row.directoryCount) || 0,
  ]));
  downloadBlob(
    new Blob(parts, { type: "text/csv;charset=utf-8" }),
    rootFileName("directories.csv"),
  );
  setExportProgress("フォルダ集計CSVを保存しました。", "success");
}

async function exportAgeCsv() {
  const rows = await Storage.getAgeBuckets();
  const totalSize = rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
  const totalCount = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const parts = [
    "\uFEFF",
    csvLine(["更新時期", "識別子", "ファイル数", "合計容量(bytes)", "件数割合", "容量割合"]),
  ];
  appendCsvRows(parts, rows, (row) => csvLine([
    row.label,
    row.bucket,
    Number(row.count) || 0,
    Number(row.size) || 0,
    totalCount > 0 ? (Number(row.count) || 0) / totalCount : 0,
    totalSize > 0 ? (Number(row.size) || 0) / totalSize : 0,
  ]));
  downloadBlob(
    new Blob(parts, { type: "text/csv;charset=utf-8" }),
    rootFileName("age-distribution.csv"),
  );
  setExportProgress("ファイル年齢分布CSVを保存しました。", "success");
}

function appendJsonArray(parts, rows) {
  parts.push("[");
  let first = true;
  for (let start = 0; start < rows.length; start += FILE_CHUNK_SIZE) {
    const values = rows.slice(start, start + FILE_CHUNK_SIZE);
    if (values.length) {
      parts.push(first ? "" : ",", values.map((row) => JSON.stringify(row)).join(","));
      first = false;
    }
  }
  parts.push("]");
}

async function loadAggregateData() {
  const [
    directories,
    extensions,
    ageBuckets,
    largestFiles,
    largestDirectories,
    duplicateCandidates,
    projectDetection,
  ] = await Promise.all([
    Storage.getDirectories(),
    Storage.getExtensions(),
    Storage.getAgeBuckets(),
    Storage.getLargestFiles(),
    Storage.getLargestDirectories(),
    Storage.getDuplicateCandidates(),
    Storage.getProjectDetection(),
  ]);
  return {
    directories,
    extensions,
    ageBuckets,
    largestFiles,
    largestDirectories,
    duplicateCandidates,
    projectDetection,
  };
}

async function exportAnalysisJson() {
  const aggregates = await loadAggregateData();
  const parts = [
    "{",
    `"schemaVersion":${JSON.stringify(state.meta.schemaVersion || 1)},`,
    `"generatedAt":${JSON.stringify(new Date().toISOString())},`,
    `"meta":${JSON.stringify(state.meta)},`,
    "\"files\":[",
  ];
  let firstFile = true;
  let count = 0;
  await measured("JSON export", () => forEachCurrentFile(
    async (files, start, total) => {
      if (files.length) {
        parts.push(
          firstFile ? "" : ",",
          files.map((file) => JSON.stringify(file)).join(","),
        );
        firstFile = false;
      }
      count += files.length;
      setExportProgress(
        `JSONを生成中: ${formatNumber(Math.min(start + files.length, total))} / ${formatNumber(total)}件`,
      );
    },
    { chunkSize: FILE_CHUNK_SIZE },
  ));
  parts.push("]");
  for (const [key, rows] of Object.entries(aggregates)) {
    parts.push(`,${JSON.stringify(key)}:`);
    appendJsonArray(parts, rows);
  }
  parts.push("}");
  downloadBlob(
    new Blob(parts, { type: "application/json;charset=utf-8" }),
    rootFileName("analysis.json"),
  );
  setExportProgress(`${formatNumber(count)}件を含む解析JSONを保存しました。`, "success");
}

function aggregateCategories(extensions) {
  const categories = new Map();
  extensions.forEach((row) => {
    const key = String(row.category || "other");
    const current = categories.get(key) || { category: key, count: 0, size: 0 };
    current.count += Number(row.count) || 0;
    current.size += Number(row.size) || 0;
    categories.set(key, current);
  });
  return [...categories.values()].sort((left, right) => right.size - left.size);
}

export function buildAnonymousPayload(meta, extensions, ageBuckets) {
  const safeExtensions = extensions.map((row) => ({
    extension: String(row.extension || ""),
    category: String(row.category || "other"),
    count: Number(row.count) || 0,
    size: Number(row.size) || 0,
  }));
  return {
    schemaVersion: Number(meta?.schemaVersion) || 1,
    generatedAt: new Date().toISOString(),
    analyzedAt: Number(meta?.analyzedAt) || 0,
    totals: {
      size: Number(meta?.totalSize) || 0,
      files: Number(meta?.totalFiles) || 0,
      directories: Number(meta?.totalDirectories) || 0,
      analysisDurationMs: Number(meta?.analysisDurationMs) || 0,
      storageDurationMs: Number(meta?.storageDurationMs) || 0,
    },
    extensions: safeExtensions,
    categories: aggregateCategories(safeExtensions),
    ageBuckets: ageBuckets.map((row) => ({
      bucket: String(row.bucket || ""),
      label: String(row.label || ""),
      order: Number(row.order) || 0,
      count: Number(row.count) || 0,
      size: Number(row.size) || 0,
    })),
  };
}

async function exportAnonymousJson() {
  const [extensions, ageBuckets] = await Promise.all([
    Storage.getExtensions(),
    Storage.getAgeBuckets(),
  ]);
  const payload = buildAnonymousPayload(state.meta, extensions, ageBuckets);
  downloadBlob(
    JSON.stringify(payload, null, 2),
    rootFileName("anonymous-analysis.json"),
    "application/json;charset=utf-8",
  );
  setExportProgress(
    "名前・フォルダ・パス・プロジェクト名を含まない匿名化JSONを保存しました。",
    "success",
  );
}

function htmlTable(headers, rows) {
  const header = headers
    .map((value) => `<th scope="col">${escapeHtml(value)}</th>`)
    .join("");
  const body = rows.length
    ? rows.map((row) => (
      `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`
    )).join("")
    : `<tr><td colspan="${headers.length}">データがありません。</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function buildHtmlReport({
  meta,
  extensions,
  ageBuckets,
  largestFiles,
  largestDirectories,
}) {
  const extensionRows = [...extensions]
    .sort((left, right) => Number(right.size) - Number(left.size))
    .slice(0, 25)
    .map((row) => [
      row.extension || "(拡張子なし)",
      formatNumber(row.count),
      formatBytes(row.size),
    ]);
  const ageRows = ageBuckets.map((row) => [
    row.label || row.bucket,
    formatNumber(row.count),
    formatBytes(row.size),
  ]);
  const fileRows = largestFiles.slice(0, 25).map((row) => [
    row.name || "-",
    row.relativePath || row.path || "-",
    formatBytes(row.size),
    formatDate(row.lastModified),
  ]);
  const directoryRows = largestDirectories.slice(0, 25).map((row) => [
    row.path || row.name || "-",
    formatBytes(row.size),
    formatNumber(row.fileCount),
  ]);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${escapeHtml(meta.rootName || "Folder Visualizer")} 解析レポート</title>
  <style>
    body{font-family:system-ui,sans-serif;line-height:1.6;color:#1f2523;max-width:1100px;margin:auto;padding:32px;background:#faf8f4}
    h1,h2{line-height:1.25}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
    .card,section{background:#fff;border:1px solid #ded8ce;border-radius:12px;padding:18px;margin:16px 0}
    .card strong{display:block;font-size:1.35rem}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%}
    th,td{border-bottom:1px solid #ded8ce;padding:8px;text-align:left;vertical-align:top}th{background:#f2eee7}
  </style>
</head>
<body>
  <header>
    <p>Folder Visualizer</p>
    <h1>${escapeHtml(meta.rootName || "-")} 解析レポート</h1>
    <p>生成日時: ${escapeHtml(formatDate(Date.now()))}</p>
  </header>
  <div class="summary">
    <div class="card">合計容量<strong>${escapeHtml(formatBytes(meta.totalSize))}</strong></div>
    <div class="card">ファイル数<strong>${escapeHtml(formatNumber(meta.totalFiles))}</strong></div>
    <div class="card">フォルダ数<strong>${escapeHtml(formatNumber(meta.totalDirectories))}</strong></div>
    <div class="card">解析日時<strong>${escapeHtml(formatDate(meta.analyzedAt))}</strong></div>
  </div>
  <section><h2>拡張子分布（上位25件）</h2>${htmlTable(["拡張子", "件数", "容量"], extensionRows)}</section>
  <section><h2>ファイル年齢分布</h2>${htmlTable(["更新時期", "件数", "容量"], ageRows)}</section>
  <section><h2>大容量ファイル（上位25件）</h2>${htmlTable(["名前", "相対パス", "容量", "更新日時"], fileRows)}</section>
  <section><h2>大容量フォルダ（上位25件）</h2>${htmlTable(["フォルダ", "容量", "ファイル数"], directoryRows)}</section>
  <footer><p>このレポートはブラウザ内で生成されました。</p></footer>
</body>
</html>`;
}

async function exportHtmlReport() {
  const [
    extensions,
    ageBuckets,
    largestFiles,
    largestDirectories,
  ] = await Promise.all([
    Storage.getExtensions(),
    Storage.getAgeBuckets(),
    Storage.getLargestFiles(),
    Storage.getLargestDirectories(),
  ]);
  const html = buildHtmlReport({
    meta: state.meta,
    extensions,
    ageBuckets,
    largestFiles,
    largestDirectories,
  });
  downloadBlob(
    html,
    rootFileName("report.html"),
    "text/html;charset=utf-8",
  );
  setExportProgress("安全化したHTML解析レポートを保存しました。", "success");
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => cleanText(item).toLocaleLowerCase("ja-JP"))
    .filter(Boolean);
}

export function normalizeStructureOptions(raw = {}) {
  return {
    format: ["markdown", "text", "json", "mermaid"].includes(raw.format)
      ? raw.format
      : "markdown",
    maxDepth: Math.max(1, Math.min(100, Math.floor(Number(raw.maxDepth) || 8))),
    maxItems: Math.max(
      10,
      Math.min(100_000, Math.floor(Number(raw.maxItems) || 5000)),
    ),
    excludePatterns: Array.isArray(raw.excludePatterns)
      ? raw.excludePatterns.map((item) => cleanText(item).toLocaleLowerCase("ja-JP")).filter(Boolean)
      : splitList(raw.excludePatterns),
    excludeExtensions: Array.isArray(raw.excludeExtensions)
      ? raw.excludeExtensions.map((item) => cleanText(item).toLocaleLowerCase("ja-JP")).filter(Boolean)
      : splitList(raw.excludeExtensions),
    includeFiles: raw.includeFiles !== false,
    includeSize: Boolean(raw.includeSize),
    includeDate: Boolean(raw.includeDate),
    includeEmpty: raw.includeEmpty !== false,
  };
}

function structureOptionsFromForm() {
  return normalizeStructureOptions({
    format: document.getElementById("structure-format")?.value,
    maxDepth: document.getElementById("structure-max-depth")?.value,
    maxItems: document.getElementById("structure-max-items")?.value,
    excludePatterns: document.getElementById("structure-exclude")?.value,
    excludeExtensions: document.getElementById(
      "structure-exclude-extensions",
    )?.value,
    includeFiles: document.getElementById("structure-include-files")?.checked,
    includeSize: document.getElementById("structure-include-size")?.checked,
    includeDate: document.getElementById("structure-include-date")?.checked,
    includeEmpty: document.getElementById("structure-include-empty")?.checked,
  });
}

function isExcludedPath(path, patterns) {
  const normalized = String(path || "").toLocaleLowerCase("ja-JP");
  return patterns.some((pattern) => normalized.includes(pattern.replaceAll("*", "")));
}

function isExcludedExtension(extension, excluded) {
  const normalized = String(extension || "").toLocaleLowerCase("ja-JP");
  return excluded.some((candidate) => {
    const withDot = candidate && !candidate.startsWith(".")
      ? `.${candidate}`
      : candidate;
    return normalized === candidate || normalized === withDot;
  });
}

function normalizeDirectory(row) {
  const path = cleanText(row?.path);
  const parts = path.split("/").filter(Boolean);
  return {
    type: "directory",
    path,
    parentPath: cleanText(row?.parentPath || parts.slice(0, -1).join("/")),
    name: cleanText(row?.name || parts.at(-1) || path || "root"),
    sourceDepth: Number.isFinite(Number(row?.sourceDepth ?? row?.depth))
      ? Number(row.sourceDepth ?? row.depth)
      : Math.max(0, parts.length - 1),
    size: Math.max(0, Number(row?.size) || 0),
    fileCount: Math.max(0, Number(row?.fileCount) || 0),
  };
}

function normalizeFile(row, rootPath) {
  const relativePath = cleanText(row?.relativePath || row?.path || row?.name);
  const path = cleanText(
    row?.path
    || (relativePath.startsWith(`${rootPath}/`)
      ? relativePath
      : `${rootPath}/${relativePath}`),
  );
  return {
    type: "file",
    path,
    parentPath: cleanText(row?.parentPath),
    name: cleanText(row?.name || relativePath.split("/").at(-1)),
    sourceDepth: Number(row?.sourceDepth ?? row?.depth) || 1,
    size: Math.max(0, Number(row?.size) || 0),
    lastModified: Math.max(0, Number(row?.lastModified) || 0),
    extension: String(row?.extension || "").toLocaleLowerCase("ja-JP"),
  };
}

function findRoot(directories, meta) {
  return directories.reduce((root, directory) => {
    if (!root) {
      return directory;
    }
    return directory.sourceDepth < root.sourceDepth
      || (
        directory.sourceDepth === root.sourceDepth
        && directory.path.length < root.path.length
      )
      ? directory
      : root;
  }, null) || normalizeDirectory({
    path: meta?.rootName || "Selected Folder",
    name: meta?.rootName || "Selected Folder",
    depth: 0,
    size: meta?.totalSize,
    fileCount: meta?.totalFiles,
  });
}

function directoryAllowed(directory, root, options) {
  if (directory.path === root.path) {
    return true;
  }
  const relativeDepth = directory.sourceDepth - root.sourceDepth;
  return (
    relativeDepth <= options.maxDepth
    && !isExcludedPath(directory.path, options.excludePatterns)
    && (options.includeEmpty || directory.fileCount > 0)
  );
}

async function collectStructureFiles(directories, root, options) {
  if (!options.includeFiles) {
    return { files: [], readTruncated: false };
  }
  const allowedDirectories = new Set(
    directories
      .filter((directory) => directoryAllowed(directory, root, options))
      .map((directory) => directory.path),
  );
  const files = [];
  let stopped = false;
  const result = await forEachCurrentFile(
    async (rows, start, total) => {
      for (const row of rows) {
        const file = normalizeFile(row, root.path);
        if (
          allowedDirectories.has(file.parentPath)
          && file.sourceDepth <= options.maxDepth
          && !isExcludedPath(file.path, options.excludePatterns)
          && !isExcludedExtension(file.extension, options.excludeExtensions)
        ) {
          files.push(file);
          if (files.length >= options.maxItems) {
            stopped = true;
            break;
          }
        }
      }
      setExportProgress(
        `構造用ファイルを準備中: ${formatNumber(Math.min(start + rows.length, total))} / ${formatNumber(total)}件`,
      );
    },
    {
      chunkSize: FILE_CHUNK_SIZE,
      isCancelled: () => stopped,
    },
  );
  return { files, readTruncated: stopped || result.cancelled };
}

export function buildStructureEntries(
  directoryRows,
  fileRows,
  meta,
  rawOptions = {},
) {
  const options = normalizeStructureOptions(rawOptions);
  const directories = directoryRows.map(normalizeDirectory);
  const root = findRoot(directories, meta);
  if (!directories.some((directory) => directory.path === root.path)) {
    directories.push(root);
  }
  const allowedDirectories = directories.filter(
    (directory) => directoryAllowed(directory, root, options),
  );
  const allowedPaths = new Set(allowedDirectories.map((directory) => directory.path));
  const childDirectories = new Map();
  allowedDirectories.forEach((directory) => {
    if (directory.path === root.path || !allowedPaths.has(directory.parentPath)) {
      return;
    }
    const children = childDirectories.get(directory.parentPath) || [];
    children.push(directory);
    childDirectories.set(directory.parentPath, children);
  });
  const filesByParent = new Map();
  if (options.includeFiles) {
    fileRows.map((row) => normalizeFile(row, root.path)).forEach((file) => {
      if (
        allowedPaths.has(file.parentPath)
        && file.sourceDepth <= options.maxDepth
        && !isExcludedPath(file.path, options.excludePatterns)
        && !isExcludedExtension(file.extension, options.excludeExtensions)
      ) {
        const children = filesByParent.get(file.parentPath) || [];
        children.push(file);
        filesByParent.set(file.parentPath, children);
      }
    });
  }

  const compareNames = (left, right) => (
    left.name.localeCompare(right.name, "ja", { sensitivity: "base" })
    || left.type.localeCompare(right.type)
  );
  const entries = [];
  let truncated = false;
  const visitDirectory = (directory, depth, ancestorLast, isLast) => {
    if (entries.length >= options.maxItems) {
      truncated = true;
      return;
    }
    entries.push({
      ...directory,
      depth,
      ancestorLast: [...ancestorLast],
      isLast,
    });
    const children = [
      ...(childDirectories.get(directory.path) || []),
      ...(filesByParent.get(directory.path) || []),
    ].sort(compareNames);
    children.forEach((child, index) => {
      if (entries.length >= options.maxItems) {
        truncated = true;
        return;
      }
      const childIsLast = index === children.length - 1;
      if (child.type === "directory") {
        visitDirectory(
          child,
          depth + 1,
          [...ancestorLast, isLast],
          childIsLast,
        );
      } else {
        entries.push({
          ...child,
          depth: depth + 1,
          ancestorLast: [...ancestorLast, isLast],
          isLast: childIsLast,
        });
      }
    });
  };
  visitDirectory(root, 0, [], true);
  const eligibleCount = allowedDirectories.length
    + [...filesByParent.values()].reduce((sum, rows) => sum + rows.length, 0);
  return {
    entries,
    root,
    options,
    truncated: truncated || entries.length < eligibleCount,
    eligibleCount,
  };
}

function entryAnnotation(entry, options) {
  const values = [];
  if (options.includeSize) {
    values.push(formatBytes(entry.size));
  }
  if (options.includeDate && entry.type === "file") {
    values.push(formatDate(entry.lastModified));
  }
  return values.length ? ` (${values.join(", ")})` : "";
}

function treePrefix(entry) {
  if (entry.depth === 0) {
    return "";
  }
  const ancestors = entry.ancestorLast
    .slice(1)
    .map((last) => (last ? "    " : "│   "))
    .join("");
  return `${ancestors}${entry.isLast ? "└── " : "├── "}`;
}

export function buildStructureOutput(model, requestedFormat = model.options.format) {
  const format = ["markdown", "text", "json", "mermaid"].includes(requestedFormat)
    ? requestedFormat
    : "markdown";
  if (format === "json") {
    return JSON.stringify({
      root: model.root.name,
      truncated: Boolean(model.truncated),
      entries: model.entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        parentPath: entry.parentPath,
        depth: entry.depth,
        ...(model.options.includeSize ? { size: entry.size } : {}),
        ...(model.options.includeDate && entry.type === "file"
          ? { lastModified: entry.lastModified }
          : {}),
      })),
    }, null, 2);
  }
  if (format === "mermaid") {
    const idByPath = new Map();
    const lines = ["graph TD"];
    model.entries.forEach((entry, index) => {
      const id = `n${index}`;
      idByPath.set(entry.path, id);
      const suffix = entry.type === "directory" ? "/" : "";
      const label = escapeMermaid(
        `${entry.name}${suffix}${entryAnnotation(entry, model.options)}`,
      ) || "(名称なし)";
      lines.push(`  ${id}["${label}"]`);
      const parentId = idByPath.get(entry.parentPath);
      if (parentId) {
        lines.push(`  ${parentId} --> ${id}`);
      }
    });
    return `${lines.join("\n")}\n`;
  }
  return `${model.entries.map((entry) => {
    const suffix = entry.type === "directory" ? "/" : "";
    const name = format === "markdown"
      ? escapeMarkdown(entry.name)
      : cleanText(entry.name);
    return `${treePrefix(entry)}${name}${suffix}${entryAnnotation(entry, model.options)}`;
  }).join("\n")}\n`;
}

function structureDownloadExtension(format) {
  return {
    markdown: "md",
    text: "txt",
    json: "json",
    mermaid: "mmd",
  }[format] || "txt";
}

async function generateStructurePreview() {
  const options = structureOptionsFromForm();
  const directoryRows = (await Storage.getDirectories()).map(normalizeDirectory);
  const root = findRoot(directoryRows, state.meta);
  const { files, readTruncated } = await collectStructureFiles(
    directoryRows,
    root,
    options,
  );
  const model = buildStructureEntries(directoryRows, files, state.meta, options);
  model.truncated ||= readTruncated;
  const output = buildStructureOutput(model, options.format);
  state.structureOutput = output;
  state.structureFormat = options.format;
  const preview = document.getElementById("structure-output");
  if (preview) {
    preview.value = output;
  }
  const warning = document.getElementById("structure-export-warning");
  const large = (
    model.truncated
    || model.eligibleCount >= LARGE_STRUCTURE_ITEMS
    || output.length >= LARGE_PREVIEW_CHARACTERS
  );
  if (warning) {
    warning.classList.toggle("hidden", !large);
    warning.textContent = model.truncated
      ? `最大${formatNumber(options.maxItems)}件で出力を打ち切りました。条件を絞ると全体を確認できます。`
      : large
        ? "出力が大きいため、コピーや保存に時間がかかる場合があります。"
        : "";
  }
  document.getElementById("copy-structure-output")?.removeAttribute("disabled");
  document.getElementById("download-structure-output")?.removeAttribute("disabled");
  setExportProgress(
    `${formatNumber(model.entries.length)}件の構造プレビューを生成しました。`,
    "success",
  );
}

async function dispatchExport(kind) {
  const handlers = {
    "files-csv": () => exportFilesCsv({}, "files.csv"),
    "filtered-csv": () => exportFilesCsv(
      queryFromUrl(window.location.search),
      "filtered-files.csv",
    ),
    "extensions-csv": exportExtensionsCsv,
    "directories-csv": exportDirectoriesCsv,
    "age-csv": exportAgeCsv,
    "analysis-json": exportAnalysisJson,
    "anonymous-json": exportAnonymousJson,
    "html-report": exportHtmlReport,
  };
  const handler = handlers[kind];
  if (!handler || state.busy) {
    return;
  }
  setBusy(true);
  setExportProgress("ブラウザ内で出力を準備しています。");
  try {
    await handler();
  } catch (error) {
    setExportProgress(
      error?.message || "出力ファイルを生成できませんでした。",
      "error",
    );
    throw error;
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => {
      void dispatchExport(button.dataset.export).catch((error) => {
        console.error("出力処理に失敗しました。", error);
      });
    });
  });
  document.getElementById("structure-export-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (state.busy) {
        return;
      }
      setBusy(true);
      void generateStructurePreview()
        .catch((error) => {
          setExportProgress(
            error?.message || "構造プレビューを生成できませんでした。",
            "error",
          );
        })
        .finally(() => setBusy(false));
    },
  );
  document.getElementById("copy-structure-output")?.addEventListener(
    "click",
    () => {
      if (!state.structureOutput) {
        setExportProgress("先にプレビューを生成してください。", "warning");
        return;
      }
      void copyText(state.structureOutput)
        .then(() => setExportProgress("構造出力をコピーしました。", "success"))
        .catch((error) => setExportProgress(error.message, "error"));
    },
  );
  document.getElementById("download-structure-output")?.addEventListener(
    "click",
    () => {
      if (!state.structureOutput) {
        setExportProgress("先にプレビューを生成してください。", "warning");
        return;
      }
      const extension = structureDownloadExtension(state.structureFormat);
      const mime = state.structureFormat === "json"
        ? "application/json;charset=utf-8"
        : "text/plain;charset=utf-8";
      downloadBlob(
        state.structureOutput,
        rootFileName(`structure.${extension}`),
        mime,
      );
      setExportProgress("フォルダ構造を保存しました。", "success");
    },
  );
}

export async function initializeExportPage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  state.meta = status.meta || await Storage.getCompleteMeta();
  if (!state.meta) {
    throw new Error("解析情報を読み込めませんでした。");
  }
  bindEvents();
  document.getElementById("copy-structure-output")?.setAttribute("disabled", "");
  document.getElementById("download-structure-output")?.setAttribute("disabled", "");
  setText(
    "export-progress",
    "出力はすべてブラウザ内で生成され、サーバへ送信されません。",
  );
}

initializeWhenReady(initializeExportPage);
