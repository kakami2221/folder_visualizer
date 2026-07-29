"use strict";

const DEFAULT_TOP_LIMIT = 5000;
const MAX_TOP_LIMIT = 5000;
const MAX_DUPLICATE_GROUPS = 5000;
const MAX_DUPLICATE_MEMBERS_PER_GROUP = 500;
const NO_EXTENSION = "(no extension)";
const PROGRESS_FILE_INTERVAL = 250;
const PROGRESS_TIME_INTERVAL_MS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

const CLEANUP_FLAGS = Object.freeze({
  OLD_LARGE: 1 << 0,
  ZERO_BYTE: 1 << 1,
  TEMPORARY: 1 << 2,
  BACKUP: 1 << 3,
  LOG: 1 << 4,
  NO_EXTENSION: 1 << 5,
  LONG_PATH: 1 << 6,
  DEEP_PATH: 1 << 7,
  BUILD_ARTIFACT: 1 << 8,
  CACHE: 1 << 9,
  VERY_LARGE: 1 << 10,
});

const CLEANUP_RULES = Object.freeze([
  ["old-large", CLEANUP_FLAGS.OLD_LARGE, "古くて大きいファイル"],
  ["zero-byte", CLEANUP_FLAGS.ZERO_BYTE, "0バイトファイル"],
  ["temporary", CLEANUP_FLAGS.TEMPORARY, "一時ファイル候補"],
  ["backup", CLEANUP_FLAGS.BACKUP, "バックアップ候補"],
  ["log", CLEANUP_FLAGS.LOG, "ログファイル"],
  ["no-extension", CLEANUP_FLAGS.NO_EXTENSION, "拡張子なし"],
  ["long-path", CLEANUP_FLAGS.LONG_PATH, "長すぎるパス"],
  ["deep-path", CLEANUP_FLAGS.DEEP_PATH, "深すぎる階層"],
  ["build-artifact", CLEANUP_FLAGS.BUILD_ARTIFACT, "ビルド生成物"],
  ["cache", CLEANUP_FLAGS.CACHE, "キャッシュフォルダ"],
  ["very-large", CLEANUP_FLAGS.VERY_LARGE, "非常に大きい単一ファイル"],
]);

const AGE_BUCKET_DEFINITIONS = Object.freeze([
  ["within-7-days", "7日以内"],
  ["within-30-days", "30日以内"],
  ["within-90-days", "90日以内"],
  ["within-6-months", "半年以内"],
  ["within-1-year", "1年以内"],
  ["older-than-1-year", "1年以上"],
  ["older-than-3-years", "3年以上"],
  ["unknown", "更新日時不明"],
]);

const CATEGORY_EXTENSION_MAP = new Map([
  ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".pyw", ".java",
    ".kt", ".kts", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp",
    ".cs", ".fs", ".fsx", ".vb", ".php", ".rb", ".swift", ".scala", ".sh",
    ".bash", ".zsh", ".fish", ".ps1", ".sql", ".html", ".htm", ".css", ".scss",
    ".sass", ".less", ".vue", ".svelte", ".xml", ".xsl", ".toml", ".yaml",
    ".yml"].map((extension) => [extension, "source-code"]),
  ...[".txt", ".md", ".markdown", ".pdf", ".doc", ".docx", ".odt", ".rtf",
    ".ppt", ".pptx", ".odp", ".xls", ".xlsx", ".ods", ".epub"].map(
    (extension) => [extension, "document"],
  ),
  ...[".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
    ".svg", ".ico", ".heic", ".avif"].map((extension) => [extension, "image"]),
  ...[".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv",
    ".mpeg", ".mpg"].map((extension) => [extension, "video"]),
  ...[".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".wma"].map(
    (extension) => [extension, "audio"],
  ),
  ...[".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".tgz",
    ".cab", ".iso"].map((extension) => [extension, "archive"]),
  ...[".json", ".jsonl", ".csv", ".tsv", ".parquet", ".db", ".sqlite",
    ".sqlite3", ".ndjson"].map((extension) => [extension, "data"]),
  ...[".exe", ".msi", ".dll", ".so", ".dylib", ".app", ".apk", ".bin",
    ".com"].map((extension) => [extension, "executable"]),
  ...[".ttf", ".otf", ".woff", ".woff2", ".eot"].map(
    (extension) => [extension, "font"],
  ),
  ...[".tmp", ".temp", ".swp", ".swo", ".part", ".crdownload"].map(
    (extension) => [extension, "temporary"],
  ),
  [".log", "log"],
  ...[".bak", ".backup", ".old", ".orig", ".save"].map(
    (extension) => [extension, "backup"],
  ),
]);

const TEMPORARY_NAMES = /(?:^|[._-])(?:tmp|temp|cache)(?:$|[._-])/iu;
const BACKUP_NAMES = /(?:^|[._-])(?:bak|backup|copy|old)(?:$|[._-])/iu;
const BUILD_DIRECTORY_NAMES = new Set([
  "node_modules", "dist", "build", "target", "out", "coverage", ".next",
  ".nuxt", ".output", "vendor",
]);
const CACHE_DIRECTORY_NAMES = new Set([
  "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".gradle", ".npm", ".yarn", ".parcel-cache",
]);

const HEALTH_RULES = Object.freeze({
  duplicateCandidates: { threshold: 10, maxDeduction: 12, label: "重複候補が多い" },
  oldLargeFiles: { threshold: 5, maxDeduction: 12, label: "古い大容量ファイルが多い" },
  emptyDirectories: { threshold: 5, maxDeduction: 5, label: "空フォルダが多い" },
  deepPaths: { threshold: 10, maxDeduction: 10, label: "深すぎる階層が多い" },
  concentratedDirectories: {
    threshold: 1,
    maxDeduction: 8,
    label: "ファイルが集中しているフォルダがある",
  },
  longPaths: { threshold: 10, maxDeduction: 8, label: "長すぎるパスが多い" },
  temporaryFiles: { threshold: 20, maxDeduction: 8, label: "一時ファイル候補が多い" },
  logFiles: { threshold: 20, maxDeduction: 6, label: "ログファイルが多い" },
  backupFiles: { threshold: 10, maxDeduction: 6, label: "バックアップ候補が多い" },
  buildArtifacts: { threshold: 20, maxDeduction: 8, label: "ビルド生成物が多い" },
  noExtensionFiles: { threshold: 20, maxDeduction: 5, label: "拡張子なしファイルが多い" },
  zeroByteFiles: { threshold: 20, maxDeduction: 4, label: "0バイトファイルが多い" },
});

let activeAnalysis = null;

class BoundedMinHeap {
  constructor(limit, comparePriority) {
    this.limit = Math.max(1, limit);
    this.comparePriority = comparePriority;
    this.items = [];
  }

  push(value) {
    if (this.items.length < this.limit) {
      this.items.push(value);
      this.#siftUp(this.items.length - 1);
      return;
    }
    if (this.comparePriority(value, this.items[0]) <= 0) {
      return;
    }
    this.items[0] = value;
    this.#siftDown(0);
  }

  toSortedDescending() {
    return [...this.items].sort((left, right) => this.comparePriority(right, left));
  }

  #siftUp(index) {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.comparePriority(this.items[current], this.items[parent]) >= 0) {
        break;
      }
      [this.items[current], this.items[parent]] = [this.items[parent], this.items[current]];
      current = parent;
    }
  }

  #siftDown(index) {
    let current = index;
    while (true) {
      const left = (current * 2) + 1;
      const right = left + 1;
      let smallest = current;
      if (
        left < this.items.length
        && this.comparePriority(this.items[left], this.items[smallest]) < 0
      ) {
        smallest = left;
      }
      if (
        right < this.items.length
        && this.comparePriority(this.items[right], this.items[smallest]) < 0
      ) {
        smallest = right;
      }
      if (smallest === current) {
        return;
      }
      [this.items[current], this.items[smallest]] = [this.items[smallest], this.items[current]];
      current = smallest;
    }
  }
}

class DuplicateGroupMap {
  constructor(mode, keyBuilder) {
    this.mode = mode;
    this.keyBuilder = keyBuilder;
    this.groups = new Map();
  }

  observe(file, compact) {
    const key = this.keyBuilder(file);
    if (key === null || key === undefined || key === "") {
      return;
    }
    const current = this.groups.get(key);
    if (!current) {
      // Keep a singleton as the shared compact record itself. A wrapper and
      // members array are allocated only if the key is observed again.
      this.groups.set(key, compact);
      return;
    }
    if (!Array.isArray(current.members)) {
      this.groups.set(key, {
        members: [current, compact],
        fileCount: 2,
        totalSize: current.size + file.size,
        truncated: false,
      });
      return;
    }
    const group = current;
    group.fileCount += 1;
    group.totalSize += file.size;
    if (group.members.length < MAX_DUPLICATE_MEMBERS_PER_GROUP) {
      group.members.push(compact);
    } else {
      group.truncated = true;
    }
  }

  finalize(analysisId) {
    const candidates = new BoundedMinHeap(
      MAX_DUPLICATE_GROUPS,
      compareDuplicateCandidatePriority,
    );
    for (const [groupKey, group] of this.groups) {
      if (!Array.isArray(group.members)) {
        continue;
      }
      const memberSize = Number(group.members[0]?.size) || 0;
      candidates.push({
        candidateKey: `${analysisId}:${this.mode}:${String(groupKey)}`,
        analysisId,
        mode: this.mode,
        groupKey: String(groupKey),
        fileCount: group.fileCount,
        totalSize: group.totalSize,
        potentialSavings: memberSize * Math.max(0, group.fileCount - 1),
        members: group.members || [],
        truncated: group.truncated,
      });
    }
    return candidates.toSortedDescending();
  }
}

function createDuplicateMetadata(file) {
  return {
    id: file.id,
    name: file.name,
    relativePath: file.relativePath,
    size: file.size,
    lastModified: file.lastModified,
    extension: file.extension,
  };
}

function timerNow() {
  return self.performance?.now?.() || Date.now();
}

function sanitizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sanitizeTopLimit(value) {
  return Math.min(
    Math.floor(sanitizePositiveNumber(value, DEFAULT_TOP_LIMIT)),
    MAX_TOP_LIMIT,
  );
}

function normalizePathParts(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
}

function getExtension(name) {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex).toLowerCase() : NO_EXTENSION;
}

function getCategory(extension) {
  if (extension === NO_EXTENSION) {
    return "no-extension";
  }
  return CATEGORY_EXTENSION_MAP.get(extension) || "other";
}

function getAgeBucket(lastModified, referenceTime) {
  if (!Number.isFinite(lastModified) || lastModified <= 0) {
    return "unknown";
  }
  const age = Math.max(0, referenceTime - lastModified);
  if (age <= 7 * DAY_MS) return "within-7-days";
  if (age <= 30 * DAY_MS) return "within-30-days";
  if (age <= 90 * DAY_MS) return "within-90-days";
  if (age <= 183 * DAY_MS) return "within-6-months";
  if (age <= YEAR_MS) return "within-1-year";
  if (age >= 3 * YEAR_MS) return "older-than-3-years";
  return "older-than-1-year";
}

function compareFilePriority(left, right) {
  return (
    (left.size - right.size)
    || (left.lastModified - right.lastModified)
    || (right.id - left.id)
  );
}

function compareDirectorySizePriority(left, right) {
  return (
    (left.size - right.size)
    || (left.fileCount - right.fileCount)
    || right.path.localeCompare(left.path)
  );
}

function compareDirectoryCountPriority(left, right) {
  return (
    (left.fileCount - right.fileCount)
    || (left.size - right.size)
    || right.path.localeCompare(left.path)
  );
}

function compareDuplicateCandidatePriority(left, right) {
  return (
    (left.potentialSavings - right.potentialSavings)
    || (left.fileCount - right.fileCount)
    || right.groupKey.localeCompare(left.groupKey)
  );
}

function createDirectory(analysisId, path, name, parentPath, depth) {
  return {
    analysisId,
    path,
    name,
    parentPath,
    depth,
    size: 0,
    fileCount: 0,
    directFileCount: 0,
    directoryCount: 0,
  };
}

function createCleanupStats() {
  return Object.fromEntries(CLEANUP_RULES.map(([key]) => [
    key,
    { key, count: 0, size: 0, sampleIds: [] },
  ]));
}

function createAgeMap(analysisId) {
  return new Map(AGE_BUCKET_DEFINITIONS.map(([bucket, label], order) => [
    bucket,
    { analysisId, bucket, label, order, count: 0, size: 0 },
  ]));
}

function createCategoryStats() {
  return new Map();
}

function normalizeOptions(message) {
  const options = message.options || {};
  return {
    oldFileMs: sanitizePositiveNumber(options.oldFileDays, 365) * DAY_MS,
    largeFileBytes: sanitizePositiveNumber(
      options.largeFileBytes,
      100 * 1024 * 1024,
    ),
    veryLargeFileBytes: sanitizePositiveNumber(
      options.veryLargeFileBytes,
      1024 * 1024 * 1024,
    ),
    longPathLength: Math.floor(sanitizePositiveNumber(options.longPathLength, 240)),
    deepPathDepth: Math.floor(sanitizePositiveNumber(options.deepPathDepth, 10)),
  };
}

function initializeAnalysis(message) {
  const requestId = String(message.requestId ?? message.analysisId ?? "");
  if (!requestId) {
    throw new Error("解析リクエストIDが指定されていません。");
  }
  const rootName = String(message.rootName || "Selected Folder");
  const directoryMap = new Map();
  directoryMap.set(
    rootName,
    createDirectory(requestId, rootName, rootName, "", 0),
  );
  activeAnalysis = {
    requestId,
    analysisId: requestId,
    rootName,
    totalExpected: Math.max(0, Number(message.totalFiles) || 0),
    referenceTime: Number(message.referenceTime) || Date.now(),
    options: normalizeOptions(message),
    processed: 0,
    totalSize: 0,
    extensionMap: new Map(),
    categoryMap: createCategoryStats(),
    ageMap: createAgeMap(requestId),
    directoryMap,
    largestFiles: new BoundedMinHeap(
      sanitizeTopLimit(message.topLimit),
      compareFilePriority,
    ),
    duplicateMaps: [
      new DuplicateGroupMap("same-size", (file) => (
        file.size > 0 ? String(file.size) : null
      )),
      new DuplicateGroupMap(
        "same-name-size",
        (file) => `${file.nameLower}\u0000${file.size}`,
      ),
      new DuplicateGroupMap(
        "same-name-size-modified",
        (file) => `${file.nameLower}\u0000${file.size}\u0000${file.lastModified}`,
      ),
    ],
    cleanupStats: createCleanupStats(),
    projectInfo: {
      fileNames: new Set(),
      directoryNames: new Set(),
      extensions: new Set(),
    },
    topLimit: sanitizeTopLimit(message.topLimit),
    processedChunkIds: new Set(),
    processingDurationMs: 0,
    startedAt: timerNow(),
    lastProgressAt: timerNow(),
    lastProgressProcessed: 0,
  };
  self.postMessage({ type: "ready", requestId, analysisId: requestId });
}

function assertActiveRequest(message) {
  if (!activeAnalysis) {
    throw new Error("解析処理が開始されていません。");
  }
  const requestId = String(message.requestId ?? message.analysisId ?? "");
  if (requestId !== activeAnalysis.requestId) {
    throw new Error("古い解析リクエストは無視されました。");
  }
  return activeAnalysis;
}

function calculateCleanupMask(file, relativeParts, state) {
  const directoryNames = relativeParts.slice(0, -1).map((part) => part.toLowerCase());
  const age = file.lastModified > 0
    ? Math.max(0, state.referenceTime - file.lastModified)
    : 0;
  let mask = 0;
  if (age >= state.options.oldFileMs && file.size >= state.options.largeFileBytes) {
    mask |= CLEANUP_FLAGS.OLD_LARGE;
  }
  if (file.size === 0) mask |= CLEANUP_FLAGS.ZERO_BYTE;
  if (file.category === "temporary" || TEMPORARY_NAMES.test(file.name)) {
    mask |= CLEANUP_FLAGS.TEMPORARY;
  }
  if (file.category === "backup" || BACKUP_NAMES.test(file.name)) {
    mask |= CLEANUP_FLAGS.BACKUP;
  }
  if (file.category === "log") mask |= CLEANUP_FLAGS.LOG;
  if (file.extension === NO_EXTENSION) mask |= CLEANUP_FLAGS.NO_EXTENSION;
  if (file.relativePath.length > state.options.longPathLength) {
    mask |= CLEANUP_FLAGS.LONG_PATH;
  }
  if (file.depth > state.options.deepPathDepth) mask |= CLEANUP_FLAGS.DEEP_PATH;
  if (directoryNames.some((name) => BUILD_DIRECTORY_NAMES.has(name))) {
    mask |= CLEANUP_FLAGS.BUILD_ARTIFACT;
  }
  if (directoryNames.some((name) => CACHE_DIRECTORY_NAMES.has(name))) {
    mask |= CLEANUP_FLAGS.CACHE;
  }
  if (file.size >= state.options.veryLargeFileBytes) {
    mask |= CLEANUP_FLAGS.VERY_LARGE;
  }
  return mask;
}

function normalizeFile(rawFile, state) {
  const fallbackName = String(rawFile.name || "unnamed");
  let inputParts = normalizePathParts(rawFile.relativePath || fallbackName);
  if (inputParts.length === 0) {
    inputParts = [fallbackName];
  }
  const relativeParts = inputParts[0] === state.rootName
    ? inputParts.slice(1)
    : inputParts;
  if (relativeParts.length === 0) {
    relativeParts.push(fallbackName);
  }
  const name = relativeParts.at(-1) || fallbackName;
  const nameLower = name.toLowerCase();
  const directoryRelativeParts = relativeParts.slice(0, -1);
  const fullDirectoryParts = [state.rootName, ...directoryRelativeParts];
  const relativePath = relativeParts.join("/");
  const path = [state.rootName, ...relativeParts].join("/");
  const parentPath = fullDirectoryParts.join("/") || state.rootName;
  const extension = getExtension(name);
  const sizeValue = Number(rawFile.size);
  const modifiedValue = Number(rawFile.lastModified);
  const file = {
    id: Number(rawFile.id),
    analysisId: state.analysisId,
    name,
    nameLower,
    relativePath,
    relativePathLower: relativePath.toLowerCase(),
    path,
    pathLower: path.toLowerCase(),
    parentPath,
    relativeParentPath: directoryRelativeParts.join("/"),
    extension,
    category: getCategory(extension),
    size: Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : 0,
    lastModified: Number.isFinite(modifiedValue) && modifiedValue >= 0 ? modifiedValue : 0,
    depth: relativeParts.length,
  };
  file.ageBucket = getAgeBucket(file.lastModified, state.referenceTime);
  file.cleanupMask = calculateCleanupMask(file, relativeParts, state);
  return { file, fullDirectoryParts, relativeParts };
}

function aggregateDirectoryData(file, directoryParts, state) {
  let currentPath = "";
  for (let depth = 0; depth < directoryParts.length; depth += 1) {
    const directoryName = directoryParts[depth];
    const parentPath = currentPath;
    currentPath = currentPath ? `${currentPath}/${directoryName}` : directoryName;
    let directory = state.directoryMap.get(currentPath);
    if (!directory) {
      directory = createDirectory(
        state.analysisId,
        currentPath,
        directoryName,
        parentPath,
        depth,
      );
      state.directoryMap.set(currentPath, directory);
    }
    directory.size += file.size;
    directory.fileCount += 1;
    if (currentPath === file.parentPath) {
      directory.directFileCount += 1;
    }
  }
}

function aggregateExtensionData(file, state) {
  let extension = state.extensionMap.get(file.extension);
  if (!extension) {
    extension = {
      analysisId: state.analysisId,
      extension: file.extension,
      category: file.category,
      size: 0,
      count: 0,
    };
    state.extensionMap.set(file.extension, extension);
  }
  extension.size += file.size;
  extension.count += 1;
}

function aggregateCategoryData(file, state) {
  let category = state.categoryMap.get(file.category);
  if (!category) {
    category = { category: file.category, count: 0, size: 0 };
    state.categoryMap.set(file.category, category);
  }
  category.count += 1;
  category.size += file.size;
}

function aggregateAgeData(file, state) {
  const bucket = state.ageMap.get(file.ageBucket);
  bucket.count += 1;
  bucket.size += file.size;
}

function aggregateCleanupData(file, state) {
  for (const [key, flag] of CLEANUP_RULES) {
    if ((file.cleanupMask & flag) === 0) {
      continue;
    }
    const stats = state.cleanupStats[key];
    stats.count += 1;
    stats.size += file.size;
    if (stats.sampleIds.length < 100) {
      stats.sampleIds.push(file.id);
    }
  }
}

function aggregateProjectInfo(file, relativeParts, state) {
  state.projectInfo.fileNames.add(file.nameLower);
  state.projectInfo.extensions.add(file.extension);
  relativeParts.slice(0, -1).forEach((part) => {
    state.projectInfo.directoryNames.add(part.toLowerCase());
  });
}

function maybeReportProgress(state, force = false) {
  const currentTime = timerNow();
  const processedSinceLastUpdate = state.processed - state.lastProgressProcessed;
  if (
    !force
    && processedSinceLastUpdate < PROGRESS_FILE_INTERVAL
    && currentTime - state.lastProgressAt < PROGRESS_TIME_INTERVAL_MS
  ) {
    return;
  }
  state.lastProgressAt = currentTime;
  state.lastProgressProcessed = state.processed;
  self.postMessage({
    type: "progress",
    requestId: state.requestId,
    analysisId: state.analysisId,
    stage: "analyzing",
    processed: state.processed,
    total: state.totalExpected,
    percent: state.totalExpected > 0
      ? Math.min(100, (state.processed / state.totalExpected) * 100)
      : 100,
    elapsedMs: Math.max(0, currentTime - state.startedAt),
  });
}

function processChunk(message) {
  const state = assertActiveRequest(message);
  const chunkId = String(message.chunkId ?? "");
  if (!chunkId) {
    throw new Error("解析チャンクIDが指定されていません。");
  }
  if (state.processedChunkIds.has(chunkId)) {
    throw new Error("同じ解析チャンクを重複して処理しようとしました。");
  }
  if (!Array.isArray(message.files)) {
    throw new Error("ファイルメタデータの形式が正しくありません。");
  }

  const startedAt = timerNow();
  const rows = new Array(message.files.length);
  for (let index = 0; index < message.files.length; index += 1) {
    const normalized = normalizeFile(message.files[index], state);
    const file = normalized.file;
    rows[index] = file;
    state.totalSize += file.size;
    state.processed += 1;
    aggregateExtensionData(file, state);
    aggregateCategoryData(file, state);
    aggregateAgeData(file, state);
    aggregateDirectoryData(file, normalized.fullDirectoryParts, state);
    aggregateCleanupData(file, state);
    aggregateProjectInfo(file, normalized.relativeParts, state);
    const duplicateMetadata = createDuplicateMetadata(file);
    state.duplicateMaps.forEach((map) => map.observe(file, duplicateMetadata));
    state.largestFiles.push(file);
    maybeReportProgress(state);
  }
  state.processingDurationMs += timerNow() - startedAt;
  state.processedChunkIds.add(chunkId);
  maybeReportProgress(state, true);
  self.postMessage({
    type: "chunkResult",
    requestId: state.requestId,
    analysisId: state.analysisId,
    chunkId,
    processed: state.processed,
    total: state.totalExpected,
    elapsedMs: timerNow() - state.startedAt,
    rows,
  });
}

function chooseExtension(current, candidate, primaryField, secondaryField) {
  if (!current) return candidate;
  if (candidate[primaryField] !== current[primaryField]) {
    return candidate[primaryField] > current[primaryField] ? candidate : current;
  }
  if (candidate[secondaryField] !== current[secondaryField]) {
    return candidate[secondaryField] > current[secondaryField] ? candidate : current;
  }
  return candidate.extension.localeCompare(current.extension) < 0 ? candidate : current;
}

function evidence(condition, text, values) {
  if (condition) values.push(text);
}

function detectProjects(state) {
  const files = state.projectInfo.fileNames;
  const directories = state.projectInfo.directoryNames;
  const extensions = state.projectInfo.extensions;
  const detections = [];
  const add = (type, score, reasons) => {
    if (score <= 0 || reasons.length === 0) return;
    detections.push({
      detectionKey: `${state.analysisId}:${type.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
      analysisId: state.analysisId,
      type,
      score: Math.min(100, score),
      confidence: score >= 80 ? "high" : score >= 50 ? "medium" : "low",
      evidence: reasons,
    });
  };

  let reasons = [];
  evidence(files.has("requirements.txt"), "requirements.txt が存在", reasons);
  evidence(files.has("pyproject.toml"), "pyproject.toml が存在", reasons);
  evidence(files.has("pipfile"), "Pipfile が存在", reasons);
  evidence(extensions.has(".py"), "Pythonファイルが存在", reasons);
  add("Python", Math.min(95, reasons.length * 25 + (extensions.has(".py") ? 15 : 0)), reasons);

  reasons = [];
  evidence(files.has("app.py"), "app.py が存在", reasons);
  evidence(directories.has("templates"), "templates フォルダが存在", reasons);
  evidence(directories.has("static"), "static フォルダが存在", reasons);
  add("Flask", files.has("app.py") ? 45 + ((reasons.length - 1) * 25) : 0, reasons);

  reasons = [];
  evidence(files.has("manage.py"), "manage.py が存在", reasons);
  evidence(files.has("wsgi.py"), "wsgi.py が存在", reasons);
  add("Django", files.has("manage.py") ? 75 + (files.has("wsgi.py") ? 20 : 0) : 0, reasons);

  reasons = [];
  evidence(files.has("package.json"), "package.json が存在", reasons);
  evidence(directories.has("node_modules"), "node_modules フォルダが存在", reasons);
  add("Node.js", files.has("package.json") ? 85 + (directories.has("node_modules") ? 10 : 0) : 0, reasons);

  reasons = [];
  evidence(extensions.has(".jsx") || extensions.has(".tsx"), "JSX/TSXファイルが存在", reasons);
  evidence(files.has("react.config.js"), "React設定ファイルが存在", reasons);
  add("React", files.has("package.json") && reasons.length ? 70 + (reasons.length * 10) : 0, reasons);

  reasons = [];
  evidence(extensions.has(".vue"), "Vueコンポーネントが存在", reasons);
  evidence(files.has("vue.config.js"), "vue.config.js が存在", reasons);
  add("Vue", files.has("package.json") && reasons.length ? 75 + (reasons.length * 10) : 0, reasons);

  reasons = [];
  evidence(
    [...files].some((name) => /^next\.config\./u.test(name)),
    "next.config ファイルが存在",
    reasons,
  );
  add("Next.js", reasons.length ? 95 : 0, reasons);

  reasons = [];
  evidence(
    [...files].some((name) => /^vite\.config\./u.test(name)),
    "vite.config ファイルが存在",
    reasons,
  );
  add("Vite", reasons.length ? 95 : 0, reasons);

  reasons = [];
  evidence(extensions.has(".java"), "Javaファイルが存在", reasons);
  add("Java", reasons.length ? 75 : 0, reasons);
  reasons = [];
  evidence(files.has("pom.xml"), "pom.xml が存在", reasons);
  add("Maven", reasons.length ? 95 : 0, reasons);
  reasons = [];
  evidence(files.has("build.gradle") || files.has("build.gradle.kts"), "Gradle設定が存在", reasons);
  add("Gradle", reasons.length ? 95 : 0, reasons);
  reasons = [];
  evidence(files.has("cargo.toml"), "Cargo.toml が存在", reasons);
  add("Rust", reasons.length ? 95 : 0, reasons);
  reasons = [];
  evidence(files.has("go.mod"), "go.mod が存在", reasons);
  evidence(extensions.has(".go"), "Goファイルが存在", reasons);
  add("Go", files.has("go.mod") ? 95 : (extensions.has(".go") ? 65 : 0), reasons);
  reasons = [];
  evidence(extensions.has(".c") || extensions.has(".h"), "Cソースが存在", reasons);
  add("C", reasons.length ? 70 : 0, reasons);
  reasons = [];
  evidence(
    [".cc", ".cpp", ".cxx", ".hpp"].some((extension) => extensions.has(extension)),
    "C++ソースが存在",
    reasons,
  );
  evidence(files.has("cmakelists.txt"), "CMakeLists.txt が存在", reasons);
  add("C++", reasons.length ? 65 + (files.has("cmakelists.txt") ? 25 : 0) : 0, reasons);
  reasons = [];
  evidence(files.has("dockerfile"), "Dockerfile が存在", reasons);
  evidence(
    files.has("docker-compose.yml") || files.has("docker-compose.yaml")
      || files.has("compose.yml") || files.has("compose.yaml"),
    "Compose設定が存在",
    reasons,
  );
  add("Docker", reasons.length ? 70 + (reasons.length * 12) : 0, reasons);
  reasons = [];
  evidence(directories.has(".git"), ".git フォルダが存在", reasons);
  add("Gitリポジトリ", reasons.length ? 95 : 0, reasons);
  return detections.sort((left, right) => right.score - left.score);
}

function countFlag(cleanupStats, key) {
  return Number(cleanupStats[key]?.count) || 0;
}

function calculateHealth(state, duplicateCandidates, directories) {
  const concentratedDirectories = directories.filter((directory) => (
    directory.path !== state.rootName
    && (
      directory.directFileCount >= 1000
      || (
        state.processed >= 100
        && directory.directFileCount / state.processed >= 0.25
      )
    )
  )).length;
  const metrics = {
    duplicateCandidates: duplicateCandidates.filter(
      (candidate) => candidate.mode === "same-name-size",
    ).length,
    oldLargeFiles: countFlag(state.cleanupStats, "old-large"),
    // Empty folders are not exposed by <input webkitdirectory>; retain the
    // metric explicitly so the UI can explain this browser limitation.
    emptyDirectories: 0,
    deepPaths: countFlag(state.cleanupStats, "deep-path"),
    concentratedDirectories,
    longPaths: countFlag(state.cleanupStats, "long-path"),
    temporaryFiles: countFlag(state.cleanupStats, "temporary"),
    logFiles: countFlag(state.cleanupStats, "log"),
    backupFiles: countFlag(state.cleanupStats, "backup"),
    buildArtifacts: countFlag(state.cleanupStats, "build-artifact"),
    noExtensionFiles: countFlag(state.cleanupStats, "no-extension"),
    zeroByteFiles: countFlag(state.cleanupStats, "zero-byte"),
  };
  let score = 100;
  const deductions = [];
  Object.entries(HEALTH_RULES).forEach(([key, rule]) => {
    const count = metrics[key] || 0;
    if (count <= 0) return;
    const points = Math.min(
      rule.maxDeduction,
      Math.max(1, Math.ceil((count / rule.threshold) * rule.maxDeduction)),
    );
    score -= points;
    deductions.push({ key, label: rule.label, count, points });
  });
  return {
    analysisId: state.analysisId,
    score: Math.max(0, score),
    deductions,
    metrics,
    constants: HEALTH_RULES,
    limitations: [
      "ブラウザのフォルダ選択では空フォルダを取得できないため、空フォルダは採点対象外です。",
    ],
  };
}

function finalizeAnalysis(message) {
  const state = assertActiveRequest(message);
  if (state.processed !== state.totalExpected) {
    throw new Error(
      `処理済みファイル数（${state.processed}件）が選択数（${state.totalExpected}件）と一致しません。`,
    );
  }
  const startedAt = timerNow();
  const directories = [...state.directoryMap.values()];
  const byParent = new Map();
  directories.forEach((directory) => {
    if (!directory.parentPath) return;
    byParent.set(directory.parentPath, (byParent.get(directory.parentPath) || 0) + 1);
  });
  directories.forEach((directory) => {
    directory.directoryCount = byParent.get(directory.path) || 0;
    directory.averageFileSize = directory.fileCount > 0
      ? directory.size / directory.fileCount
      : 0;
  });

  const extensions = [...state.extensionMap.values()];
  const ageBuckets = [...state.ageMap.values()];
  const categoryStats = [...state.categoryMap.values()]
    .sort((left, right) => right.size - left.size);
  const largestFiles = state.largestFiles
    .toSortedDescending()
    .map((file, index) => ({ ...file, rank: index + 1 }));

  const subdirectories = directories.filter((directory) => directory.path !== state.rootName);
  const directoryCandidates = subdirectories.length > 0 ? subdirectories : directories;
  const sizeHeap = new BoundedMinHeap(state.topLimit, compareDirectorySizePriority);
  const countHeap = new BoundedMinHeap(state.topLimit, compareDirectoryCountPriority);
  directoryCandidates.forEach((directory) => {
    sizeHeap.push(directory);
    countHeap.push(directory);
  });
  const directoriesBySize = sizeHeap.toSortedDescending();
  const directoriesByFileCount = countHeap.toSortedDescending();
  const largestDirectoryMap = new Map();
  directoriesBySize.forEach((directory, index) => {
    largestDirectoryMap.set(directory.path, { ...directory, rankSize: index + 1 });
  });
  directoriesByFileCount.forEach((directory, index) => {
    const current = largestDirectoryMap.get(directory.path) || { ...directory };
    current.rankFileCount = index + 1;
    largestDirectoryMap.set(directory.path, current);
  });
  const largestDirectories = [...largestDirectoryMap.values()];

  let mostCommonExtension = null;
  let largestExtension = null;
  extensions.forEach((extension) => {
    mostCommonExtension = chooseExtension(
      mostCommonExtension,
      extension,
      "count",
      "size",
    );
    largestExtension = chooseExtension(largestExtension, extension, "size", "count");
  });

  const duplicateCandidates = state.duplicateMaps.flatMap(
    (map) => map.finalize(state.analysisId),
  );
  const projectDetection = detectProjects(state);
  const health = calculateHealth(state, duplicateCandidates, directories);
  const cleanupStats = Object.values(state.cleanupStats);
  state.processingDurationMs += timerNow() - startedAt;
  const summary = {
    analysisId: state.analysisId,
    rootName: state.rootName,
    totalSize: state.totalSize,
    totalFiles: state.processed,
    totalDirectories: directories.length,
    largestFile: largestFiles[0] || null,
    largestDirectory: directoriesBySize[0] || null,
    mostCommonExtension,
    largestExtension,
    categoryStats,
    cleanupStats,
    health,
    projectCount: projectDetection.length,
    duplicateGroupCount: duplicateCandidates.length,
  };

  maybeReportProgress(state, true);
  self.postMessage({
    type: "result",
    requestId: state.requestId,
    analysisId: state.analysisId,
    directories,
    extensions,
    ageBuckets,
    largestFiles,
    largestDirectories,
    duplicateCandidates,
    projectDetection,
    categoryStats,
    cleanupStats,
    health,
    summary,
    analysisDurationMs: state.processingDurationMs,
    elapsedMs: timerNow() - state.startedAt,
  });
  activeAnalysis = null;
}

function cancelAnalysis(message) {
  if (!activeAnalysis) return;
  const requestId = String(message.requestId ?? message.analysisId ?? "");
  if (requestId !== activeAnalysis.requestId) return;
  activeAnalysis = null;
  self.postMessage({ type: "cancelled", requestId, analysisId: requestId });
}

function reportError(error, requestId) {
  self.postMessage({
    type: "error",
    requestId: String(requestId ?? activeAnalysis?.requestId ?? ""),
    analysisId: String(requestId ?? activeAnalysis?.analysisId ?? ""),
    message: error instanceof Error && error.message
      ? error.message
      : "Web Workerで不明なエラーが発生しました。",
  });
}

self.onmessage = (event) => {
  const message = event.data || {};
  try {
    switch (message.type) {
      case "init":
        initializeAnalysis(message);
        break;
      case "chunk":
        processChunk(message);
        break;
      case "complete":
        finalizeAnalysis(message);
        break;
      case "cancel":
        cancelAnalysis(message);
        break;
      default:
        throw new Error(`未対応のWorkerメッセージです: ${String(message.type)}`);
    }
  } catch (error) {
    reportError(error, message.requestId ?? message.analysisId);
  }
};
