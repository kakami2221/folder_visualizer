import {
  ANALYSIS_STATUS,
  DEFAULT_ANALYSIS_OPTIONS,
} from "../common/constants.js";
import Storage from "../storage/index.js";

export const CHUNK_SIZE = DEFAULT_ANALYSIS_OPTIONS.chunkSize;
export const TOP_LIMIT = DEFAULT_ANALYSIS_OPTIONS.topLimit;
export const AGGREGATE_WRITE_CHUNK_SIZE =
  DEFAULT_ANALYSIS_OPTIONS.aggregateWriteChunkSize;
export const WORKER_START_TIMEOUT_MS = 15_000;
export const ANALYSIS_LOCK_NAME = "folder-visualizer-analysis";

const workerUrl = new URL("./analysis-worker.js", import.meta.url);
let requestSequence = 0;
let activeRun = null;
let activeLockRequest = null;
let sessionFileList = null;

function currentTime() {
  return globalThis.performance?.now?.() || Date.now();
}

export function createAbortError(message = "解析をキャンセルしました。") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function createAnalyzerError(message, cause) {
  const error = new Error(message);
  error.name = "FolderVisualizerAnalyzerError";
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function emitProgress(run, progress) {
  if (run.cancelled || activeRun !== run) {
    return;
  }
  const requestedPercent = Math.min(100, Math.max(0, Number(progress.percent) || 0));
  const percent = Math.max(run.lastPercent || 0, requestedPercent);
  run.lastPercent = percent;
  try {
    run.onProgress({
      stage: String(progress.stage || "解析中"),
      message: String(progress.message || ""),
      processed: Math.max(0, Number(progress.processed) || 0),
      total: Math.max(0, Number(progress.total) || run.totalFiles),
      percent,
      elapsedMs: Math.max(
        0,
        Number(progress.elapsedMs) || (currentTime() - run.startedAt),
      ),
      analysisId: run.analysisId,
    });
  } catch (error) {
    console.error("Folder Visualizer: 進捗表示の更新に失敗しました。", error);
  }
}

function rejectWorkerWaiters(run, error) {
  if (run.fatalError) {
    return;
  }
  run.fatalError = error;
  run.ready.reject(error);
  run.pendingChunks.forEach((deferred) => deferred.reject(error));
  run.pendingChunks.clear();
  run.finalResult?.reject(error);
}

function attachWorkerHandlers(run) {
  run.worker.onmessage = (event) => {
    const message = event.data || {};
    if (String(message.requestId ?? message.analysisId ?? "") !== run.analysisId) {
      return;
    }
    switch (message.type) {
      case "ready":
        run.ready.resolve();
        break;
      case "progress": {
        const ratio = run.totalFiles > 0 ? Number(message.processed) / run.totalFiles : 1;
        emitProgress(run, {
          stage: "フォルダ構造を解析中",
          message: "カテゴリ、年齢、整理候補、重複候補をまとめて集計しています。",
          processed: message.processed,
          total: run.totalFiles,
          percent: 15 + (Math.min(1, ratio) * 65),
          elapsedMs: message.elapsedMs,
        });
        break;
      }
      case "chunkResult": {
        const key = String(message.chunkId);
        const deferred = run.pendingChunks.get(key);
        if (deferred) {
          run.pendingChunks.delete(key);
          deferred.resolve(message);
        }
        break;
      }
      case "result":
        run.finalResult?.resolve(message);
        break;
      case "cancelled":
        rejectWorkerWaiters(run, createAbortError());
        break;
      case "error":
        rejectWorkerWaiters(
          run,
          createAnalyzerError(
            message.message || "Web Workerで解析中にエラーが発生しました。",
          ),
        );
        break;
      default:
        rejectWorkerWaiters(
          run,
          createAnalyzerError(`Web Workerから不明な応答を受信しました: ${String(message.type)}`),
        );
    }
  };
  run.worker.onerror = (event) => {
    event.preventDefault?.();
    rejectWorkerWaiters(
      run,
      createAnalyzerError(
        "Web Workerの実行中にエラーが発生しました。もう一度解析してください。",
        event.error || event.message,
      ),
    );
  };
  run.worker.onmessageerror = (event) => {
    rejectWorkerWaiters(
      run,
      createAnalyzerError("Web Workerとのデータ受け渡しに失敗しました。", event.data),
    );
  };
}

function createRun(fileList, onProgress) {
  if (typeof globalThis.Worker !== "function") {
    throw createAnalyzerError(
      "このブラウザではWeb Workerを利用できません。対応ブラウザで再試行してください。",
    );
  }
  let worker;
  try {
    worker = new Worker(workerUrl, { type: "module", name: "folder-analysis" });
  } catch (error) {
    throw createAnalyzerError("解析用Web Workerを起動できませんでした。", error);
  }
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${++requestSequence}`;
  const run = {
    analysisId: String(randomId),
    worker,
    fileList,
    totalFiles: Number(fileList.length) || 0,
    onProgress,
    cancelled: false,
    fatalError: null,
    ready: createDeferred(),
    finalResult: null,
    pendingChunks: new Map(),
    lastPercent: 0,
    startedAt: currentTime(),
  };
  attachWorkerHandlers(run);
  return run;
}

function assertRunActive(run) {
  if (run.cancelled || activeRun !== run) {
    throw createAbortError();
  }
  if (run.fatalError) {
    throw run.fatalError;
  }
}

export function getRootName(fileList) {
  const relativePath = String(fileList?.[0]?.webkitRelativePath || "")
    .replaceAll("\\", "/");
  return relativePath.split("/").filter(Boolean)[0] || "Selected Folder";
}

export function prepareMetadataChunk(fileList, start, end) {
  const rows = new Array(end - start);
  for (let index = start; index < end; index += 1) {
    const file = fileList[index];
    if (!file) {
      throw createAnalyzerError(`ファイル情報を取得できませんでした（${index + 1}件目）。`);
    }
    rows[index - start] = {
      id: index,
      name: String(file.name || ""),
      relativePath: String(file.webkitRelativePath || file.name || ""),
      size: Math.max(0, Number(file.size) || 0),
      lastModified: Math.max(0, Number(file.lastModified) || 0),
    };
  }
  return rows;
}

function waitForWorkerReady(run) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = globalThis.setTimeout(() => reject(createAnalyzerError(
      "解析用Web Workerの起動に時間がかかりすぎています。ページを再読み込みしてください。",
    )), WORKER_START_TIMEOUT_MS);
  });
  return Promise.race([run.ready.promise, timeout])
    .finally(() => globalThis.clearTimeout(timerId));
}

function processWorkerChunk(run, chunkId, files) {
  assertRunActive(run);
  const deferred = createDeferred();
  run.pendingChunks.set(chunkId, deferred);
  try {
    run.worker.postMessage({
      type: "chunk",
      requestId: run.analysisId,
      analysisId: run.analysisId,
      chunkId,
      files,
    });
  } catch (error) {
    run.pendingChunks.delete(chunkId);
    throw createAnalyzerError("ファイル情報をWeb Workerへ送信できませんでした。", error);
  }
  return deferred.promise;
}

function requestFinalResult(run) {
  assertRunActive(run);
  run.finalResult = createDeferred();
  run.worker.postMessage({
    type: "complete",
    requestId: run.analysisId,
    analysisId: run.analysisId,
  });
  return run.finalResult.promise;
}

function yieldToBrowser() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

async function saveRecordsInChunks(storeName, rows, run, timings) {
  const records = Array.isArray(rows) ? rows : [];
  for (let start = 0; start < records.length; start += AGGREGATE_WRITE_CHUNK_SIZE) {
    assertRunActive(run);
    const storageStartedAt = currentTime();
    await Storage.putRecords(
      storeName,
      records.slice(start, start + AGGREGATE_WRITE_CHUNK_SIZE),
    );
    timings.storageDurationMs += currentTime() - storageStartedAt;
    await yieldToBrowser();
  }
}

function recordPerformanceMeasures(timings, analysisId, totalStartMark) {
  const values = {
    "metadata preparation": timings.metadataDurationMs,
    "worker analysis": timings.analysisDurationMs,
    "indexedDB storage": timings.storageDurationMs,
    total: timings.totalDurationMs,
  };
  Object.entries(values).forEach(([name, duration]) => {
    try {
      globalThis.performance?.measure?.(`Folder Visualizer · ${name}`, {
        start: 0,
        duration: Math.max(0, Number(duration) || 0),
        detail: { analysisId },
      });
    } catch {
      // Performance entries are optional.
    }
  });
  if (totalStartMark) {
    const totalEndMark = `${totalStartMark}:end`;
    try {
      performance.mark(totalEndMark);
      performance.measure(`Folder Visualizer total · ${analysisId}`, totalStartMark, totalEndMark);
    } catch {
      // Analysis must not depend on performance measurement support.
    } finally {
      performance.clearMarks?.(totalStartMark);
      performance.clearMarks?.(totalEndMark);
    }
  }
  if (globalThis.FolderVisualizer?.performanceLogging) {
    console.groupCollapsed("Folder Visualizer Performance");
    console.table(Object.entries(values).map(([measure, duration]) => ({
      measure,
      milliseconds: Number(duration).toFixed(1),
    })));
    console.groupEnd();
  }
}

async function storeWorkerResult(workerResult, run, timings) {
  const jobs = [
    [Storage.STORES.DIRECTORIES, workerResult.directories],
    [Storage.STORES.EXTENSIONS, workerResult.extensions],
    [Storage.STORES.AGE_BUCKETS, workerResult.ageBuckets],
    [Storage.STORES.LARGEST_FILES, workerResult.largestFiles],
    [Storage.STORES.LARGEST_DIRECTORIES, workerResult.largestDirectories],
    [Storage.STORES.DUPLICATE_CANDIDATES, workerResult.duplicateCandidates],
    [Storage.STORES.PROJECT_DETECTION, workerResult.projectDetection],
  ];
  for (const [storeName, rows] of jobs) {
    await saveRecordsInChunks(storeName, rows, run, timings);
  }
}

function validateFileList(fileList) {
  if (!fileList || !Number.isFinite(Number(fileList.length)) || fileList.length === 0) {
    throw createAnalyzerError("解析するフォルダを選択してください。");
  }
}

async function waitForLocalLockRelease() {
  const pending = activeLockRequest;
  if (!pending) {
    return;
  }
  try {
    await pending;
  } catch {
    // The original analyze() caller receives the failure. A following local
    // run only needs to wait until the browser has released the origin lock.
  }
  if (activeLockRequest === pending) {
    activeLockRequest = null;
  }
}

function createLockUnavailableError() {
  const error = createAnalyzerError(
    "別のタブで解析中です。完了またはキャンセル後に、もう一度お試しください。",
  );
  error.code = "analysis-lock-unavailable";
  return error;
}

export async function analyze(fileList, options = {}) {
  validateFileList(fileList);
  if (activeRun) {
    await cancel();
  }
  await waitForLocalLockRelease();

  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") {
    return runAnalysis(fileList, options);
  }

  let lockRequest;
  lockRequest = locks.request(
    ANALYSIS_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    (lock) => {
      if (!lock) {
        throw createLockUnavailableError();
      }
      return runAnalysis(fileList, options);
    },
  );
  activeLockRequest = lockRequest;
  try {
    return await lockRequest;
  } finally {
    if (activeLockRequest === lockRequest) {
      activeLockRequest = null;
    }
  }
}

async function runAnalysis(fileList, options = {}) {
  validateFileList(fileList);
  if (activeRun) {
    await cancel();
  }

  const onProgress = typeof options.onProgress === "function"
    ? options.onProgress
    : () => {};
  const run = createRun(fileList, onProgress);
  const rootName = getRootName(fileList);
  const totalStartedAt = currentTime();
  const totalStartMark = `folder-visualizer:${run.analysisId}:total:start`;
  const timings = {
    metadataDurationMs: 0,
    analysisDurationMs: 0,
    storageDurationMs: 0,
    totalDurationMs: 0,
  };
  activeRun = run;
  sessionFileList = null;

  try {
    globalThis.performance?.mark?.(totalStartMark);
    emitProgress(run, {
      stage: "ファイル情報を準備中",
      message: "選択したファイルのメタデータを準備しています。",
      processed: 0,
      total: run.totalFiles,
      percent: 0,
    });

    const storageStartedAt = currentTime();
    await Storage.beginAnalysis({
      analysisId: run.analysisId,
      rootName,
      analyzedAt: Date.now(),
      totalFiles: run.totalFiles,
    });
    timings.storageDurationMs += currentTime() - storageStartedAt;
    assertRunActive(run);

    run.worker.postMessage({
      type: "init",
      requestId: run.analysisId,
      analysisId: run.analysisId,
      rootName,
      totalFiles: run.totalFiles,
      referenceTime: Date.now(),
      topLimit: Number(options.topLimit) || TOP_LIMIT,
      options: {
        oldFileDays: options.oldFileDays,
        largeFileBytes: options.largeFileBytes,
        veryLargeFileBytes: options.veryLargeFileBytes,
        longPathLength: options.longPathLength,
        deepPathDepth: options.deepPathDepth,
      },
    });
    await waitForWorkerReady(run);

    for (let start = 0; start < run.totalFiles; start += CHUNK_SIZE) {
      assertRunActive(run);
      const end = Math.min(start + CHUNK_SIZE, run.totalFiles);
      const metadataStartedAt = currentTime();
      const metadata = prepareMetadataChunk(fileList, start, end);
      timings.metadataDurationMs += currentTime() - metadataStartedAt;
      emitProgress(run, {
        stage: "ファイル情報を準備中",
        message: "内容は読まず、名前・パス・サイズ・更新日時だけを準備しています。",
        processed: end,
        total: run.totalFiles,
        percent: 15 * (end / run.totalFiles),
      });
      const chunkId = `${start}-${end}`;
      const workerResult = await processWorkerChunk(run, chunkId, metadata);
      assertRunActive(run);
      const fileStorageStartedAt = currentTime();
      await Storage.putFileChunk(workerResult.rows);
      timings.storageDurationMs += currentTime() - fileStorageStartedAt;
      await yieldToBrowser();
    }

    emitProgress(run, {
      stage: "解析結果を保存中",
      message: "集計結果を確定してIndexedDBへ保存しています。",
      processed: run.totalFiles,
      total: run.totalFiles,
      percent: 82,
    });
    const workerResult = await requestFinalResult(run);
    assertRunActive(run);
    timings.analysisDurationMs = Math.max(
      0,
      Number(workerResult.analysisDurationMs) || 0,
    );
    await storeWorkerResult(workerResult, run, timings);
    assertRunActive(run);

    const summary = workerResult.summary;
    timings.totalDurationMs = currentTime() - totalStartedAt;
    const completionStartedAt = currentTime();
    const completedMeta = await Storage.completeAnalysis({
      analysisId: run.analysisId,
      rootName: summary.rootName,
      analyzedAt: Date.now(),
      finishedAt: Date.now(),
      totalSize: summary.totalSize,
      totalFiles: summary.totalFiles,
      totalDirectories: summary.totalDirectories,
      metadataDurationMs: timings.metadataDurationMs,
      analysisDurationMs: timings.analysisDurationMs,
      storageDurationMs: timings.storageDurationMs,
      totalDurationMs: timings.totalDurationMs,
      largestFile: summary.largestFile,
      largestDirectory: summary.largestDirectory,
      mostCommonExtension: summary.mostCommonExtension,
      largestExtension: summary.largestExtension,
      categoryStats: workerResult.categoryStats,
      cleanupStats: workerResult.cleanupStats,
      health: workerResult.health,
      duplicateGroupCount: summary.duplicateGroupCount,
      projectCount: summary.projectCount,
      status: ANALYSIS_STATUS.COMPLETE,
    });
    timings.storageDurationMs += currentTime() - completionStartedAt;
    timings.totalDurationMs = currentTime() - totalStartedAt;
    assertRunActive(run);

    let historyWarning = null;
    try {
      const historyStartedAt = currentTime();
      await Storage.createHistorySnapshot({
        ...completedMeta,
        storageDurationMs: timings.storageDurationMs,
        totalDurationMs: timings.totalDurationMs,
      });
      timings.storageDurationMs += currentTime() - historyStartedAt;
      timings.totalDurationMs = currentTime() - totalStartedAt;
    } catch (error) {
      historyWarning = error;
      console.warn("解析は完了しましたが、履歴を保存できませんでした。", error);
    }

    assertRunActive(run);
    sessionFileList = fileList;
    emitProgress(run, {
      stage: "完了",
      message: historyWarning
        ? "解析は完了しました。保存容量の都合で履歴は保存されていません。"
        : "解析結果と履歴の保存が完了しました。",
      processed: run.totalFiles,
      total: run.totalFiles,
      percent: 100,
    });
    recordPerformanceMeasures(timings, run.analysisId, totalStartMark);
    run.worker.terminate();
    if (activeRun === run) {
      activeRun = null;
    }
    return {
      meta: {
        ...completedMeta,
        storageDurationMs: timings.storageDurationMs,
        totalDurationMs: timings.totalDurationMs,
      },
      summary,
      health: workerResult.health,
      cleanupStats: workerResult.cleanupStats,
      categoryStats: workerResult.categoryStats,
      timings: { ...timings },
      historyWarning,
    };
  } catch (error) {
    run.worker.terminate();
    if (activeRun === run) {
      activeRun = null;
    }
    sessionFileList = null;
    try {
      if (run.cancelled || error?.name === "AbortError") {
        await Storage.cancelAnalysis(run.analysisId, {
          analysisDurationMs: timings.analysisDurationMs,
          storageDurationMs: timings.storageDurationMs,
        });
      } else {
        await Storage.failAnalysis(run.analysisId, error, {
          analysisDurationMs: timings.analysisDurationMs,
          storageDurationMs: timings.storageDurationMs,
        });
      }
    } catch (statusError) {
      console.error("中断された解析の状態を保存できませんでした。", statusError);
    }
    globalThis.performance?.clearMarks?.(totalStartMark);
    if (run.cancelled || error?.name === "AbortError") {
      throw createAbortError();
    }
    throw error instanceof Error
      ? error
      : createAnalyzerError("フォルダの解析中に不明なエラーが発生しました。", error);
  }
}

export async function cancel() {
  const run = activeRun;
  if (!run) {
    return false;
  }
  run.cancelled = true;
  rejectWorkerWaiters(run, createAbortError());
  try {
    run.worker.postMessage({
      type: "cancel",
      requestId: run.analysisId,
      analysisId: run.analysisId,
    });
  } catch {
    // terminate() below is authoritative.
  }
  run.worker.terminate();
  if (activeRun === run) {
    activeRun = null;
  }
  sessionFileList = null;
  try {
    await Storage.cancelAnalysis(run.analysisId);
  } catch (error) {
    console.error("キャンセルした解析の状態を保存できませんでした。", error);
  }
  return true;
}

export function isRunning() {
  return Boolean(activeRun && !activeRun.cancelled);
}

export function getActiveAnalysisId() {
  return activeRun?.analysisId || null;
}

export function hasSessionFiles() {
  return Boolean(sessionFileList);
}

export function getSessionFile(id) {
  const index = Number(id);
  return Number.isInteger(index) && index >= 0 ? sessionFileList?.[index] || null : null;
}

export function getSessionFiles(ids = []) {
  return Array.from(ids, (id) => getSessionFile(id)).filter(Boolean);
}

export function clearSessionFiles() {
  sessionFileList = null;
}

const Analyzer = Object.freeze({
  AGGREGATE_WRITE_CHUNK_SIZE,
  CHUNK_SIZE,
  TOP_LIMIT,
  WORKER_START_TIMEOUT_MS,
  analyze,
  cancel,
  clearSessionFiles,
  getActiveAnalysisId,
  getRootName,
  getSessionFile,
  getSessionFiles,
  hasSessionFiles,
  isRunning,
  prepareMetadataChunk,
});

if (typeof window !== "undefined") {
  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  app.Analyzer = Analyzer;
  app.analyzer = Analyzer;
}

export default Analyzer;
