import Analyzer from "./analyzer.js";
import Storage from "../storage/index.js";

const workerUrl = new URL("./duplicate-worker.js", import.meta.url);
let activeJob = null;

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `hash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function verifyDuplicateFiles(ids, options = {}) {
  if (activeJob) {
    await cancelDuplicateVerification();
  }
  if (!Analyzer.hasSessionFiles()) {
    throw new Error(
      "精密確認には、このタブで選択した元ファイルが必要です。フォルダを再解析してください。",
    );
  }
  const requestedIds = Array.from(new Set(Array.from(ids || [], Number)))
    .filter((id) => Number.isInteger(id) && id >= 0);
  const files = requestedIds.map((id) => ({
    id,
    file: Analyzer.getSessionFile(id),
  })).filter((entry) => entry.file);
  if (files.length === 0) {
    throw new Error("精密確認する候補ファイルを選択してください。");
  }

  const requestId = makeRequestId();
  const worker = new Worker(workerUrl, { type: "module", name: "duplicate-hasher" });
  const onProgress = typeof options.onProgress === "function"
    ? options.onProgress
    : () => {};
  const job = { requestId, worker };
  activeJob = job;

  try {
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (String(message.requestId) !== requestId) return;
        if (message.type === "progress") {
          onProgress(message);
        } else if (message.type === "result") {
          resolve(message);
        } else if (message.type === "cancelled") {
          const error = new Error("精密確認をキャンセルしました。");
          error.name = "AbortError";
          reject(error);
        } else if (message.type === "error") {
          reject(new Error(message.message || "精密確認に失敗しました。"));
        }
      };
      worker.onerror = () => reject(new Error("精密確認用Workerを実行できませんでした。"));
      worker.postMessage({
        type: "hash",
        requestId,
        analysisId: String(options.analysisId || ""),
        tasks: files.map((entry) => ({
          ...entry,
          relativePath: String(
            entry.file.webkitRelativePath || entry.file.name || "",
          ).replaceAll("\\", "/"),
        })),
        maxHashBytes: options.maxHashBytes,
        allowLargeFiles: options.allowLargeFiles === true,
      });
    });

    const verifiedAt = Date.now();
    const records = result.results.map((row) => ({
      ...row,
      analysisId: String(options.analysisId || row.analysisId || ""),
      fileId: row.id,
      hashKey: `${String(options.analysisId || row.analysisId || "session")}:${row.id}`,
      verifiedAt,
    }));
    await Storage.saveDuplicateHashes(records);
    return { ...result, records };
  } finally {
    worker.terminate();
    if (activeJob === job) {
      activeJob = null;
    }
  }
}

export async function cancelDuplicateVerification() {
  const job = activeJob;
  if (!job) return false;
  job.worker.postMessage({ type: "cancel", requestId: job.requestId });
  job.worker.terminate();
  activeJob = null;
  return true;
}

export function isDuplicateVerificationRunning() {
  return Boolean(activeJob);
}
