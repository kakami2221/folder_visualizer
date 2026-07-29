import {
  DB_NAME,
  DB_VERSION,
  upgradeDatabase,
} from "./migrations.js";

let databasePromise = null;
export const BLOCKED_OPEN_TIMEOUT_MS = 8_000;

export function createStorageError(message, cause) {
  const error = new Error(message);
  error.name = "FolderVisualizerStorageError";
  if (cause !== undefined) {
    error.cause = cause;
    if (cause?.name === "QuotaExceededError") {
      error.code = "quota-exceeded";
    }
  }
  return error;
}

export function requestResult(request, message = "IndexedDBの処理に失敗しました。") {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(createStorageError(message, request.error));
  });
}

export function transactionDone(
  transaction,
  message = "IndexedDBへの保存に失敗しました。",
) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(createStorageError(message, transaction.error));
    transaction.onerror = () => {
      // Abort is the authoritative transaction failure event.
    };
  });
}

export function openDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.reject(createStorageError(
      "このブラウザではIndexedDBを利用できません。対応ブラウザで再試行してください。",
    ));
  }
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    let request;
    let blockedTimer = 0;
    let settled = false;
    const clearBlockedTimer = () => {
      if (blockedTimer) {
        globalThis.clearTimeout(blockedTimer);
        blockedTimer = 0;
      }
    };
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearBlockedTimer();
      reject(error);
    };
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      rejectOnce(createStorageError("IndexedDBを開けませんでした。", error));
      return;
    }

    request.onupgradeneeded = (event) => {
      upgradeDatabase(request.result, request.transaction, Number(event.oldVersion) || 0);
    };
    request.onblocked = () => {
      console.warn("Folder Visualizer: 別のタブを閉じると保存領域を更新できます。");
      if (!blockedTimer) {
        blockedTimer = globalThis.setTimeout(() => {
          const error = createStorageError(
            "IndexedDBの更新が別のタブでブロックされています。"
              + "Folder Visualizerを開いている他のタブを閉じて、"
              + "このページを再読み込みしてください。",
          );
          error.code = "database-blocked";
          rejectOnce(error);
        }, BLOCKED_OPEN_TIMEOUT_MS);
      }
    };
    request.onerror = () => {
      rejectOnce(createStorageError(
        "IndexedDBの初期化に失敗しました。ブラウザの保存領域設定を確認してください。",
        request.error,
      ));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      clearBlockedTimer();
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

export async function closeDatabase() {
  if (!databasePromise) {
    return;
  }
  try {
    const database = await databasePromise;
    database.close();
  } finally {
    databasePromise = null;
  }
}

export function resetDatabaseConnectionForTests() {
  databasePromise = null;
}
