const workerUrl = new URL("./compare-worker.js", import.meta.url);
const DEFAULT_CHUNK_SIZE = 2000;
let activeJob = null;

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `compare-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function abortError() {
  const error = new Error("比較処理をキャンセルしました。");
  error.name = "AbortError";
  return error;
}

async function yieldToBrowser() {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

export async function compareSources(sourceA, sourceB, options = {}) {
  if (activeJob) {
    await cancelComparison();
  }
  const rowsA = Array.from(sourceA || []);
  const rowsB = Array.from(sourceB || []);
  const requestId = makeRequestId();
  const comparisonId = String(options.comparisonId || requestId);
  const chunkSize = Math.max(500, Math.min(5000, Number(options.chunkSize) || DEFAULT_CHUNK_SIZE));
  const worker = new Worker(workerUrl, { type: "module", name: "folder-comparison" });
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const job = { requestId, worker, cancelled: false };
  activeJob = job;

  const resultPromise = new Promise((resolve, reject) => {
    job.reject = reject;
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (String(message.requestId) !== requestId || job.cancelled) {
        return;
      }
      if (message.type === "ready") {
        job.ready = true;
        job.readyResolve?.();
      } else if (message.type === "progress") {
        onProgress(message);
      } else if (message.type === "result") {
        resolve(message);
      } else if (message.type === "error") {
        reject(new Error(message.message || "フォルダ比較に失敗しました。"));
      }
    };
    worker.onerror = (event) => {
      reject(new Error(event.message || "比較用Workerを実行できませんでした。"));
    };
  });

  const readyPromise = new Promise((resolve) => {
    job.readyResolve = resolve;
  });
  try {
    worker.postMessage({
      type: "init",
      requestId,
      totalA: rowsA.length,
      totalB: rowsB.length,
    });
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => globalThis.setTimeout(
        () => reject(new Error("比較用Workerを開始できませんでした。")),
        15_000,
      )),
    ]);
    for (const [side, rows] of [["A", rowsA], ["B", rowsB]]) {
      for (let start = 0; start < rows.length; start += chunkSize) {
        if (job.cancelled || activeJob !== job) {
          throw abortError();
        }
        worker.postMessage({
          type: "chunk",
          requestId,
          side,
          files: rows.slice(start, start + chunkSize),
        });
        await yieldToBrowser();
      }
    }
    worker.postMessage({ type: "complete", requestId, comparisonId });
    return await resultPromise;
  } finally {
    worker.terminate();
    if (activeJob === job) {
      activeJob = null;
    }
  }
}

export async function cancelComparison() {
  const job = activeJob;
  if (!job) {
    return false;
  }
  job.cancelled = true;
  job.reject?.(abortError());
  try {
    job.worker.postMessage({ type: "cancel", requestId: job.requestId });
  } finally {
    job.worker.terminate();
    activeJob = null;
  }
  return true;
}

export function isComparisonRunning() {
  return Boolean(activeJob);
}
