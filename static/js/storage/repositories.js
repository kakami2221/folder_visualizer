import {
  ANALYSIS_STATUS,
  DEFAULT_ANALYSIS_OPTIONS,
} from "../common/constants.js";
import {
  createStorageError,
  openDatabase,
  requestResult,
  transactionDone,
} from "./database.js";
import {
  CURRENT_ANALYSIS_STORES,
  DATA_VERSION,
  DB_NAME,
  DB_VERSION,
  STORES,
  WRITABLE_RECORD_STORES,
} from "./migrations.js";

const DEFAULT_SETTINGS = Object.freeze({
  historyLimit: DEFAULT_ANALYSIS_OPTIONS.historyLimit,
  autoPruneHistory: true,
  performanceLogging: false,
  tableSize: "medium",
});

function now() {
  return Date.now();
}

function makeId(prefix) {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function uniqueStoreNames(names) {
  return [...new Set(names)];
}

async function readOne(storeName, key, message) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction, message);
  const result = await requestResult(transaction.objectStore(storeName).get(key), message);
  await done;
  return result ?? null;
}

export async function getAllRecords(storeName) {
  const database = await openDatabase();
  if (!database.objectStoreNames.contains(storeName)) {
    throw createStorageError(`保存先「${String(storeName)}」は存在しません。`);
  }
  const message = `解析結果（${storeName}）を読み込めませんでした。`;
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction, message);
  const rows = await requestResult(transaction.objectStore(storeName).getAll(), message);
  await done;
  return rows;
}

export async function getRecordsByIndex(storeName, indexName, value) {
  const database = await openDatabase();
  const message = `解析結果（${storeName}）を読み込めませんでした。`;
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction, message);
  const store = transaction.objectStore(storeName);
  if (!store.indexNames.contains(indexName)) {
    throw createStorageError(`検索項目「${String(indexName)}」は利用できません。`);
  }
  const rows = await requestResult(store.index(indexName).getAll(value), message);
  await done;
  return rows;
}

export async function putRecords(storeName, rows) {
  if (!WRITABLE_RECORD_STORES.has(storeName)) {
    throw createStorageError(`保存先「${String(storeName)}」は使用できません。`);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  const database = await openDatabase();
  const message = `解析結果（${storeName}）をIndexedDBへ保存できませんでした。`;
  const transaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(transaction, message);
  const store = transaction.objectStore(storeName);
  rows.forEach((row) => store.put(row));
  await done;
  return rows.length;
}

export function putFileChunk(rows) {
  return putRecords(STORES.FILES, rows);
}

export async function readCurrentMeta() {
  return readOne(
    STORES.ANALYSIS_META,
    "current",
    "解析情報の読み込みに失敗しました。",
  );
}

export async function getAnalysisStatus() {
  const meta = await readCurrentMeta();
  if (!meta) {
    return {
      status: "none",
      available: false,
      usable: false,
      meta: null,
      reason: "missing",
    };
  }
  if (
    Number(meta.schemaVersion ?? meta.dataVersion ?? meta.version) !== DATA_VERSION
    || meta.requiresReanalysis === true
  ) {
    return {
      status: "stale",
      available: false,
      usable: false,
      meta: null,
      storedMeta: meta,
      reason: "outdated",
      message: "保存済みデータのバージョンが古いため、再解析が必要です。",
    };
  }
  if (meta.status !== ANALYSIS_STATUS.COMPLETE) {
    return {
      status: meta.status || ANALYSIS_STATUS.FAILED,
      available: false,
      usable: false,
      meta,
      reason: meta.status || "incomplete",
    };
  }
  return {
    status: ANALYSIS_STATUS.COMPLETE,
    available: true,
    usable: true,
    meta,
    reason: null,
  };
}

export async function getCompleteMeta() {
  const status = await getAnalysisStatus();
  return status.usable ? status.meta : null;
}

export async function beginAnalysis(meta = {}) {
  const database = await openDatabase();
  const stores = uniqueStoreNames([STORES.ANALYSIS_META, ...CURRENT_ANALYSIS_STORES]);
  const message = "以前の解析結果を初期化できませんでした。保存領域の空き容量を確認してください。";
  const transaction = database.transaction(stores, "readwrite");
  const done = transactionDone(transaction, message);
  CURRENT_ANALYSIS_STORES.forEach((storeName) => {
    transaction.objectStore(storeName).clear();
  });
  const record = {
    ...meta,
    id: "current",
    analysisId: String(meta.analysisId || makeId("analysis")),
    rootName: String(meta.rootName || "Selected Folder"),
    analyzedAt: Number(meta.analyzedAt) || now(),
    status: ANALYSIS_STATUS.PROCESSING,
    totalSize: 0,
    totalFiles: Math.max(0, Number(meta.totalFiles) || 0),
    totalDirectories: 0,
    analysisDurationMs: 0,
    storageDurationMs: 0,
    schemaVersion: DATA_VERSION,
    dataVersion: DATA_VERSION,
    version: DATA_VERSION,
  };
  transaction.objectStore(STORES.ANALYSIS_META).put(record);
  await done;
  return record;
}

export async function markAnalysisStatus(analysisId, status, details = {}) {
  if (!Object.values(ANALYSIS_STATUS).includes(status)) {
    throw createStorageError(`不正な解析状態です: ${String(status)}`);
  }
  const database = await openDatabase();
  const storeNames = details.clearPayload
    ? uniqueStoreNames([STORES.ANALYSIS_META, ...CURRENT_ANALYSIS_STORES])
    : [STORES.ANALYSIS_META];
  const message = "解析状態を保存できませんでした。";
  const transaction = database.transaction(storeNames, "readwrite");
  const done = transactionDone(transaction, message);
  const store = transaction.objectStore(STORES.ANALYSIS_META);
  const request = store.get("current");
  let updated = null;
  let logicalError = null;
  request.onsuccess = () => {
    const current = request.result;
    if (!current || String(current.analysisId) !== String(analysisId)) {
      logicalError = createStorageError("古い解析処理の状態は保存されませんでした。");
      transaction.abort();
      return;
    }
    if (details.clearPayload) {
      CURRENT_ANALYSIS_STORES.forEach((storeName) => {
        transaction.objectStore(storeName).clear();
      });
    }
    updated = {
      ...current,
      ...details,
      id: "current",
      analysisId: current.analysisId,
      status,
      schemaVersion: DATA_VERSION,
      dataVersion: DATA_VERSION,
      version: DATA_VERSION,
      updatedAt: now(),
    };
    delete updated.clearPayload;
    store.put(updated);
  };
  request.onerror = () => {
    logicalError = createStorageError("解析状態の確認に失敗しました。", request.error);
  };
  try {
    await done;
  } catch (error) {
    throw logicalError || error;
  }
  return updated;
}

export function completeAnalysis(meta) {
  return markAnalysisStatus(meta?.analysisId, ANALYSIS_STATUS.COMPLETE, meta);
}

export function cancelAnalysis(analysisId, details = {}) {
  return markAnalysisStatus(analysisId, ANALYSIS_STATUS.CANCELLED, {
    ...details,
    clearPayload: true,
    finishedAt: now(),
  });
}

export function failAnalysis(analysisId, error, details = {}) {
  return markAnalysisStatus(analysisId, ANALYSIS_STATUS.FAILED, {
    ...details,
    clearPayload: true,
    finishedAt: now(),
    errorCode: String(error?.code || error?.name || "analysis-failed"),
    // Do not persist file names, paths, stack traces, or arbitrary exception text.
    errorMessage: "解析を完了できませんでした。",
  });
}

export async function clearAnalysis(expectedAnalysisId) {
  const database = await openDatabase();
  const stores = uniqueStoreNames([STORES.ANALYSIS_META, ...CURRENT_ANALYSIS_STORES]);
  const message = "解析結果を削除できませんでした。";
  const transaction = database.transaction(stores, "readwrite");
  const done = transactionDone(transaction, message);
  const metaStore = transaction.objectStore(STORES.ANALYSIS_META);
  const request = metaStore.get("current");
  let cleared = false;
  request.onsuccess = () => {
    const current = request.result;
    const matches = expectedAnalysisId === undefined
      || expectedAnalysisId === null
      || (
        current
        && String(current.analysisId) === String(expectedAnalysisId)
      );
    if (!matches) {
      return;
    }
    metaStore.delete("current");
    CURRENT_ANALYSIS_STORES.forEach((storeName) => {
      transaction.objectStore(storeName).clear();
    });
    cleared = true;
  };
  await done;
  return cleared;
}

function sortRanked(rows, rankField) {
  return rows.sort((left, right) => (
    (Number(left[rankField]) || Number.MAX_SAFE_INTEGER)
      - (Number(right[rankField]) || Number.MAX_SAFE_INTEGER)
  ) || (Number(right.size) - Number(left.size)));
}

export function getExtensions() {
  return getAllRecords(STORES.EXTENSIONS);
}

export function getDirectories() {
  return getAllRecords(STORES.DIRECTORIES);
}

export function getAgeBuckets() {
  return getAllRecords(STORES.AGE_BUCKETS)
    .then((rows) => rows.sort((left, right) => Number(left.order) - Number(right.order)));
}

export function getLargestFiles() {
  return getAllRecords(STORES.LARGEST_FILES)
    .then((rows) => sortRanked(rows, "rank"));
}

export function getLargestDirectories() {
  return getAllRecords(STORES.LARGEST_DIRECTORIES)
    .then((rows) => sortRanked(rows, "rankSize"));
}

export function getDuplicateCandidates(mode = "") {
  if (!mode) {
    return getAllRecords(STORES.DUPLICATE_CANDIDATES)
      .then((rows) => rows.sort(
        (left, right) => Number(right.potentialSavings) - Number(left.potentialSavings),
      ));
  }
  return getRecordsByIndex(STORES.DUPLICATE_CANDIDATES, "mode", String(mode))
    .then((rows) => rows.sort(
      (left, right) => Number(right.potentialSavings) - Number(left.potentialSavings),
    ));
}

export function getDuplicateHashes() {
  return getAllRecords(STORES.DUPLICATE_HASHES);
}

export function getProjectDetection() {
  return getAllRecords(STORES.PROJECT_DETECTION)
    .then((rows) => rows.sort((left, right) => Number(right.score) - Number(left.score)));
}

function normalizeQuery(criteria = {}) {
  const rawName = String(criteria.name ?? criteria.nameQuery ?? "").trim();
  const minimum = Number(criteria.minSize);
  const maximum = criteria.maxSize === "" || criteria.maxSize === null
    || criteria.maxSize === undefined
    ? Number.POSITIVE_INFINITY
    : Number(criteria.maxSize);
  const updatedFrom = Number(criteria.updatedFrom ?? criteria.minLastModified);
  const updatedToRaw = criteria.updatedTo ?? criteria.maxLastModified;
  const updatedTo = updatedToRaw === "" || updatedToRaw === null || updatedToRaw === undefined
    ? Number.POSITIVE_INFINITY
    : Number(updatedToRaw);
  const requestedSort = criteria.sortBy || "nameLower";
  const sortAliases = {
    id: null,
    name: "nameLower",
    nameLower: "nameLower",
    path: "relativePathLower",
    pathLower: "relativePathLower",
    relativePath: "relativePathLower",
    relativePathLower: "relativePathLower",
    extension: "extension",
    category: "category",
    size: "size",
    lastModified: "lastModified",
    depth: "depth",
  };

  let regularExpression = null;
  const regexSource = String(criteria.regex ?? "").trim();
  const useRegex = Boolean(criteria.useRegex || regexSource);
  if (useRegex) {
    const pattern = regexSource || rawName;
    try {
      regularExpression = new RegExp(pattern, criteria.caseSensitive ? "u" : "iu");
    } catch (error) {
      throw createStorageError("正規表現が正しくありません。入力内容を確認してください。", error);
    }
  }

  const directory = String(criteria.directory || "");
  return {
    analysisId: String(criteria.analysisId || ""),
    name: useRegex ? "" : rawName.toLowerCase(),
    path: String(criteria.path ?? criteria.pathQuery ?? "").trim().toLowerCase(),
    extension: String(criteria.extension || ""),
    category: String(criteria.category || ""),
    parentPath: String(criteria.parentPath || ""),
    directory,
    includeDescendants: criteria.includeDescendants !== false,
    ageBucket: String(criteria.ageBucket ?? criteria.age ?? ""),
    minSize: Number.isFinite(minimum) && minimum >= 0 ? minimum : 0,
    maxSize: Number.isFinite(maximum) && maximum >= 0 ? maximum : Number.POSITIVE_INFINITY,
    updatedFrom: Number.isFinite(updatedFrom) && updatedFrom >= 0 ? updatedFrom : 0,
    updatedTo: Number.isFinite(updatedTo) && updatedTo >= 0
      ? updatedTo
      : Number.POSITIVE_INFINITY,
    minDepth: Math.max(0, Number(criteria.minDepth) || 0),
    maxDepth: Number.isFinite(Number(criteria.maxDepth))
      ? Math.max(0, Number(criteria.maxDepth))
      : Number.POSITIVE_INFINITY,
    cleanupMask: Math.max(0, Number(criteria.cleanupMask) || 0),
    regularExpression,
    sortIndex: Object.prototype.hasOwnProperty.call(sortAliases, requestedSort)
      ? sortAliases[requestedSort]
      : "nameLower",
    direction: String(criteria.direction).toLowerCase() === "desc" ? "prev" : "next",
  };
}

function createCursorRange(query) {
  if (query.sortIndex === "size") {
    const hasUpper = Number.isFinite(query.maxSize);
    if (query.minSize > 0 && hasUpper) {
      return globalThis.IDBKeyRange.bound(query.minSize, query.maxSize);
    }
    if (query.minSize > 0) {
      return globalThis.IDBKeyRange.lowerBound(query.minSize);
    }
    if (hasUpper) {
      return globalThis.IDBKeyRange.upperBound(query.maxSize);
    }
  }
  if (query.sortIndex === "lastModified") {
    const hasUpper = Number.isFinite(query.updatedTo);
    if (query.updatedFrom > 0 && hasUpper) {
      return globalThis.IDBKeyRange.bound(query.updatedFrom, query.updatedTo);
    }
    if (query.updatedFrom > 0) {
      return globalThis.IDBKeyRange.lowerBound(query.updatedFrom);
    }
    if (hasUpper) {
      return globalThis.IDBKeyRange.upperBound(query.updatedTo);
    }
  }
  return undefined;
}

function matchesQuery(row, query) {
  const relativePathLower = String(row.relativePathLower || row.pathLower || "").toLowerCase();
  const nameLower = String(row.nameLower || row.name || "").toLowerCase();
  const directoryMatches = !query.directory || (
    query.includeDescendants
      ? (
        String(row.parentPath) === query.directory
        || String(row.parentPath).startsWith(`${query.directory}/`)
      )
      : String(row.parentPath) === query.directory
  );
  const regexTarget = `${String(row.name || "")}\n${String(row.relativePath || row.path || "")}`;
  return (
    (!query.analysisId || String(row.analysisId) === query.analysisId)
    && (!query.name || nameLower.includes(query.name))
    && (!query.path || relativePathLower.includes(query.path))
    && (!query.extension || row.extension === query.extension)
    && (!query.category || row.category === query.category)
    && (!query.parentPath || row.parentPath === query.parentPath)
    && directoryMatches
    && (!query.ageBucket || row.ageBucket === query.ageBucket)
    && Number(row.size) >= query.minSize
    && Number(row.size) <= query.maxSize
    && Number(row.lastModified) >= query.updatedFrom
    && Number(row.lastModified) <= query.updatedTo
    && Number(row.depth) >= query.minDepth
    && Number(row.depth) <= query.maxDepth
    && (!query.cleanupMask || (Number(row.cleanupMask) & query.cleanupMask) !== 0)
    && (!query.regularExpression || query.regularExpression.test(regexTarget))
  );
}

function canUseAllKeys(query) {
  return (
    !query.analysisId
    && !query.name
    && !query.path
    && !query.extension
    && !query.category
    && !query.parentPath
    && !query.directory
    && !query.ageBucket
    && query.minSize === 0
    && !Number.isFinite(query.maxSize)
    && query.updatedFrom === 0
    && !Number.isFinite(query.updatedTo)
    && query.minDepth === 0
    && !Number.isFinite(query.maxDepth)
    && !query.cleanupMask
    && !query.regularExpression
  );
}

export async function queryFileIds(criteria = {}, options = {}) {
  const query = normalizeQuery(criteria);
  const isCancelled = typeof options.isCancelled === "function"
    ? options.isCancelled
    : () => false;
  const onProgress = typeof options.onProgress === "function"
    ? options.onProgress
    : () => {};
  const reportProgress = (progress) => {
    try {
      onProgress(progress);
    } catch (error) {
      console.error("Folder Visualizer: 検索進捗の更新に失敗しました。", error);
    }
  };
  const offset = Math.max(0, Number(options.offset ?? criteria.offset) || 0);
  const requestedLimit = Number(options.limit ?? criteria.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit >= 0
    ? Math.floor(requestedLimit)
    : Number.POSITIVE_INFINITY;
  if (
    query.minSize > query.maxSize
    || query.updatedFrom > query.updatedTo
    || query.minDepth > query.maxDepth
  ) {
    return { ids: [], totalSize: 0, totalCount: 0, cancelled: false };
  }

  const database = await openDatabase();
  const transaction = database.transaction(STORES.FILES, "readonly");
  const store = transaction.objectStore(STORES.FILES);
  const source = query.sortIndex ? store.index(query.sortIndex) : store;
  const range = createCursorRange(query);

  if (canUseAllKeys(query)) {
    const done = transactionDone(transaction, "ファイル一覧の並び順を読み込めませんでした。");
    if (isCancelled()) {
      return { ids: [], totalSize: 0, totalCount: 0, cancelled: true };
    }
    const allIds = await requestResult(
      source.getAllKeys(range),
      "ファイル一覧の並び順を読み込めませんでした。",
    );
    await done;
    if (isCancelled()) {
      return { ids: [], totalSize: 0, totalCount: 0, cancelled: true };
    }
    if (query.direction === "prev") {
      allIds.reverse();
    }
    const ids = Number.isFinite(limit)
      ? allIds.slice(offset, offset + limit)
      : allIds.slice(offset);
    const meta = await readCurrentMeta();
    reportProgress({ processed: allIds.length, matched: allIds.length, total: allIds.length });
    return {
      ids,
      totalSize: Number(meta?.totalSize) || 0,
      totalCount: allIds.length,
      cancelled: false,
    };
  }

  return new Promise((resolve, reject) => {
    const ids = [];
    let totalSize = 0;
    let totalCount = 0;
    let processed = 0;
    let scanTotal = 0;
    let lastProgressAt = globalThis.performance?.now?.() || Date.now();
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const countRequest = source.count(range);
    countRequest.onsuccess = () => {
      scanTotal = Number(countRequest.result) || 0;
    };
    const cursorRequest = source.openCursor(range, query.direction);
    cursorRequest.onerror = () => {
      if (!settled) {
        settled = true;
        reject(createStorageError(
          "ファイル一覧の検索中にエラーが発生しました。",
          cursorRequest.error,
        ));
      }
    };
    cursorRequest.onsuccess = () => {
      if (settled) {
        return;
      }
      if (isCancelled()) {
        finish({ ids: [], totalSize: 0, totalCount: 0, cancelled: true });
        return;
      }
      const cursor = cursorRequest.result;
      if (!cursor) {
        reportProgress({ processed, matched: totalCount, total: scanTotal || processed });
        finish({ ids, totalSize, totalCount, cancelled: false });
        return;
      }
      processed += 1;
      const row = cursor.value;
      if (matchesQuery(row, query)) {
        if (totalCount >= offset && ids.length < limit) {
          ids.push(row.id);
        }
        totalCount += 1;
        totalSize += Number(row.size) || 0;
      }
      const current = globalThis.performance?.now?.() || Date.now();
      if (processed % 1000 === 0 || current - lastProgressAt >= 100) {
        lastProgressAt = current;
        reportProgress({ processed, matched: totalCount, total: scanTotal });
      }
      cursor.continue();
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(createStorageError("ファイル一覧の検索が中断されました。", transaction.error));
      }
    };
  });
}

export async function getFilesByIds(ids) {
  const requestedIds = Array.from(ids || []);
  if (requestedIds.length === 0) {
    return [];
  }
  const database = await openDatabase();
  const transaction = database.transaction(STORES.FILES, "readonly");
  const done = transactionDone(transaction, "ファイル情報を読み込めませんでした。");
  const store = transaction.objectStore(STORES.FILES);
  const rows = await Promise.all(requestedIds.map((id) => requestResult(
    store.get(id),
    `ファイル情報（ID: ${String(id)}）を読み込めませんでした。`,
  )));
  await done;
  return rows.filter((row) => row !== undefined);
}

export async function getFileRange(criteria = {}, offset = 0, limit = 500, options = {}) {
  const result = await queryFileIds(criteria, { ...options, offset, limit });
  if (result.cancelled) {
    return { ...result, files: [] };
  }
  const files = await getFilesByIds(result.ids);
  return { ...result, files };
}

async function deleteHistoryInTransaction(transaction, analysisId) {
  transaction.objectStore(STORES.ANALYSIS_HISTORY).delete(analysisId);
  const fileIndex = transaction.objectStore(STORES.HISTORY_FILES).index("analysisId");
  const request = fileIndex.openKeyCursor(globalThis.IDBKeyRange.only(analysisId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }
    transaction.objectStore(STORES.HISTORY_FILES).delete(cursor.primaryKey);
    cursor.continue();
  };
}

export async function createHistorySnapshot(meta = null) {
  const completedMeta = meta || await getCompleteMeta();
  if (!completedMeta || completedMeta.status !== ANALYSIS_STATUS.COMPLETE) {
    return null;
  }
  const analysisId = String(completedMeta.analysisId);
  const database = await openDatabase();
  const stores = [STORES.FILES, STORES.ANALYSIS_HISTORY, STORES.HISTORY_FILES];
  const message = "解析履歴を保存できませんでした。";
  const transaction = database.transaction(stores, "readwrite");
  const done = transactionDone(transaction, message);
  await deleteHistoryInTransaction(transaction, analysisId);
  const historyMeta = {
    ...completedMeta,
    id: undefined,
    analysisId,
    status: ANALYSIS_STATUS.COMPLETE,
    schemaVersion: DATA_VERSION,
  };
  delete historyMeta.id;
  transaction.objectStore(STORES.ANALYSIS_HISTORY).put(historyMeta);
  const historyStore = transaction.objectStore(STORES.HISTORY_FILES);
  const cursorRequest = transaction.objectStore(STORES.FILES).openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      return;
    }
    const row = cursor.value;
    historyStore.put({
      ...row,
      analysisId,
      historyKey: `${analysisId}:${String(row.id)}`,
    });
    cursor.continue();
  };
  await done;
  const autoPrune = await getSetting("autoPruneHistory", DEFAULT_SETTINGS.autoPruneHistory);
  if (autoPrune) {
    const historyLimit = await getSetting("historyLimit", DEFAULT_SETTINGS.historyLimit);
    await pruneHistory(historyLimit);
  }
  return historyMeta;
}

export async function listHistory() {
  const rows = await getAllRecords(STORES.ANALYSIS_HISTORY);
  return rows
    .filter((row) => row.status === ANALYSIS_STATUS.COMPLETE)
    .sort((left, right) => Number(right.analyzedAt) - Number(left.analyzedAt));
}

export function getHistoryFiles(analysisId) {
  return getRecordsByIndex(STORES.HISTORY_FILES, "analysisId", String(analysisId));
}

export async function deleteHistory(analysisId) {
  const database = await openDatabase();
  const message = "解析履歴を削除できませんでした。";
  const transaction = database.transaction(
    [STORES.ANALYSIS_HISTORY, STORES.HISTORY_FILES],
    "readwrite",
  );
  const done = transactionDone(transaction, message);
  await deleteHistoryInTransaction(transaction, String(analysisId));
  await done;
  return true;
}

export async function clearHistory() {
  const database = await openDatabase();
  const transaction = database.transaction(
    [STORES.ANALYSIS_HISTORY, STORES.HISTORY_FILES],
    "readwrite",
  );
  const done = transactionDone(transaction, "解析履歴を削除できませんでした。");
  transaction.objectStore(STORES.ANALYSIS_HISTORY).clear();
  transaction.objectStore(STORES.HISTORY_FILES).clear();
  await done;
}

export async function pruneHistory(limit = DEFAULT_SETTINGS.historyLimit) {
  const normalizedLimit = Math.max(0, Math.min(100, Math.floor(Number(limit) || 0)));
  const rows = await listHistory();
  const excess = rows.slice(normalizedLimit);
  for (const history of excess) {
    await deleteHistory(history.analysisId);
  }
  return excess.length;
}

export async function getSetting(key, fallback = null) {
  const record = await readOne(
    STORES.APP_SETTINGS,
    String(key),
    "アプリ設定を読み込めませんでした。",
  );
  return record ? record.value : fallback;
}

export async function getSettings() {
  const records = await getAllRecords(STORES.APP_SETTINGS);
  const values = { ...DEFAULT_SETTINGS };
  records.forEach((record) => {
    values[record.key] = record.value;
  });
  return values;
}

export async function saveSetting(key, value) {
  const record = { key: String(key), value, updatedAt: now() };
  await putRecords(STORES.APP_SETTINGS, [record]);
  return record;
}

export async function saveSettings(values = {}) {
  const records = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    updatedAt: now(),
  }));
  await putRecords(STORES.APP_SETTINGS, records);
  return getSettings();
}

export async function listSavedSearches() {
  const rows = await getAllRecords(STORES.SAVED_SEARCHES);
  return rows.sort(
    (left, right) => Number(left.order) - Number(right.order)
      || Number(left.createdAt) - Number(right.createdAt),
  );
}

async function makeUniqueSearchName(requestedName, excludedId = "") {
  const baseName = String(requestedName || "").trim();
  if (!baseName) {
    throw createStorageError("保存する検索条件の名前を入力してください。");
  }
  const rows = await listSavedSearches();
  const names = new Set(rows
    .filter((row) => String(row.id) !== String(excludedId))
    .map((row) => String(row.name).toLocaleLowerCase("ja-JP")));
  if (!names.has(baseName.toLocaleLowerCase("ja-JP"))) {
    return baseName;
  }
  let suffix = 2;
  while (names.has(`${baseName} (${suffix})`.toLocaleLowerCase("ja-JP"))) {
    suffix += 1;
  }
  return `${baseName} (${suffix})`;
}

export async function createSavedSearch(name, criteria = {}) {
  const rows = await listSavedSearches();
  const createdAt = now();
  const record = {
    id: makeId("search"),
    name: await makeUniqueSearchName(name),
    nameLower: "",
    criteria: { ...criteria },
    order: rows.length,
    createdAt,
    updatedAt: createdAt,
  };
  record.nameLower = record.name.toLocaleLowerCase("ja-JP");
  await putRecords(STORES.SAVED_SEARCHES, [record]);
  return record;
}

export async function renameSavedSearch(id, name) {
  const record = await readOne(
    STORES.SAVED_SEARCHES,
    String(id),
    "保存済み検索を読み込めませんでした。",
  );
  if (!record) {
    throw createStorageError("名前を変更する保存済み検索が見つかりません。");
  }
  record.name = await makeUniqueSearchName(name, id);
  record.nameLower = record.name.toLocaleLowerCase("ja-JP");
  record.updatedAt = now();
  await putRecords(STORES.SAVED_SEARCHES, [record]);
  return record;
}

export async function deleteSavedSearch(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORES.SAVED_SEARCHES, "readwrite");
  const done = transactionDone(transaction, "保存済み検索を削除できませんでした。");
  transaction.objectStore(STORES.SAVED_SEARCHES).delete(String(id));
  await done;
  return true;
}

export async function reorderSavedSearches(ids = []) {
  const current = await listSavedSearches();
  const byId = new Map(current.map((row) => [String(row.id), row]));
  const ordered = [];
  ids.forEach((id) => {
    const record = byId.get(String(id));
    if (record) {
      ordered.push(record);
      byId.delete(String(id));
    }
  });
  ordered.push(...byId.values());
  const updatedAt = now();
  ordered.forEach((row, index) => {
    row.order = index;
    row.updatedAt = updatedAt;
  });
  await putRecords(STORES.SAVED_SEARCHES, ordered);
  return ordered;
}

export function saveCleanupRules(rules = []) {
  const updatedAt = now();
  return putRecords(STORES.CLEANUP_RULES, rules.map((rule, index) => ({
    ...rule,
    id: String(rule.id || `rule-${index}`),
    updatedAt,
  })));
}

export function getCleanupRules() {
  return getAllRecords(STORES.CLEANUP_RULES);
}

export function saveDuplicateHashes(rows) {
  return putRecords(STORES.DUPLICATE_HASHES, rows);
}

export function saveComparisonResults(rows) {
  return putRecords(STORES.COMPARISON_RESULTS, rows);
}

export function getComparisonResults(comparisonId) {
  return getRecordsByIndex(
    STORES.COMPARISON_RESULTS,
    "comparisonId",
    String(comparisonId),
  );
}

export async function clearComparisonResults() {
  const database = await openDatabase();
  const transaction = database.transaction(STORES.COMPARISON_RESULTS, "readwrite");
  const done = transactionDone(transaction, "比較結果を削除できませんでした。");
  transaction.objectStore(STORES.COMPARISON_RESULTS).clear();
  await done;
}

export {
  DATA_VERSION,
  DB_NAME,
  DB_VERSION,
  DEFAULT_SETTINGS,
  STORES,
};
