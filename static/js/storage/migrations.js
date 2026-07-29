import { APP_SCHEMA_VERSION } from "../common/constants.js";

export const DB_NAME = "folder-visualizer-db";
export const DB_VERSION = APP_SCHEMA_VERSION;
export const DATA_VERSION = APP_SCHEMA_VERSION;

export const STORES = Object.freeze({
  ANALYSIS_META: "analysisMeta",
  FILES: "files",
  DIRECTORIES: "directories",
  EXTENSIONS: "extensions",
  AGE_BUCKETS: "ageBuckets",
  LARGEST_FILES: "largestFiles",
  LARGEST_DIRECTORIES: "largestDirectories",
  DUPLICATE_CANDIDATES: "duplicateCandidates",
  DUPLICATE_HASHES: "duplicateHashes",
  ANALYSIS_HISTORY: "analysisHistory",
  HISTORY_FILES: "historyFiles",
  SAVED_SEARCHES: "savedSearches",
  CLEANUP_RULES: "cleanupRules",
  APP_SETTINGS: "appSettings",
  PROJECT_DETECTION: "projectDetection",
  COMPARISON_RESULTS: "comparisonResults",
});

export const CURRENT_ANALYSIS_STORES = Object.freeze([
  STORES.FILES,
  STORES.DIRECTORIES,
  STORES.EXTENSIONS,
  STORES.AGE_BUCKETS,
  STORES.LARGEST_FILES,
  STORES.LARGEST_DIRECTORIES,
  STORES.DUPLICATE_CANDIDATES,
  STORES.DUPLICATE_HASHES,
  STORES.PROJECT_DETECTION,
]);

export const WRITABLE_RECORD_STORES = new Set([
  ...CURRENT_ANALYSIS_STORES,
  STORES.ANALYSIS_HISTORY,
  STORES.HISTORY_FILES,
  STORES.SAVED_SEARCHES,
  STORES.CLEANUP_RULES,
  STORES.APP_SETTINGS,
  STORES.COMPARISON_RESULTS,
]);

const STORE_DEFINITIONS = Object.freeze({
  [STORES.ANALYSIS_META]: Object.freeze({
    keyPath: "id",
    indexes: Object.freeze({
      analysisId: "analysisId",
      status: "status",
      analyzedAt: "analyzedAt",
    }),
  }),
  [STORES.FILES]: Object.freeze({
    keyPath: "id",
    indexes: Object.freeze({
      analysisId: "analysisId",
      nameLower: "nameLower",
      relativePathLower: "relativePathLower",
      pathLower: "pathLower",
      parentPath: "parentPath",
      extension: "extension",
      category: "category",
      size: "size",
      lastModified: "lastModified",
      depth: "depth",
      ageBucket: "ageBucket",
      cleanupMask: "cleanupMask",
    }),
  }),
  [STORES.DIRECTORIES]: Object.freeze({
    keyPath: "path",
    indexes: Object.freeze({
      analysisId: "analysisId",
      parentPath: "parentPath",
      depth: "depth",
      size: "size",
      fileCount: "fileCount",
    }),
  }),
  [STORES.EXTENSIONS]: Object.freeze({
    keyPath: "extension",
    indexes: Object.freeze({
      analysisId: "analysisId",
      category: "category",
      size: "size",
      count: "count",
    }),
  }),
  [STORES.AGE_BUCKETS]: Object.freeze({
    keyPath: "bucket",
    indexes: Object.freeze({
      analysisId: "analysisId",
      order: "order",
      count: "count",
      size: "size",
    }),
  }),
  [STORES.LARGEST_FILES]: Object.freeze({
    keyPath: "id",
    indexes: Object.freeze({
      analysisId: "analysisId",
      rank: "rank",
      size: "size",
      lastModified: "lastModified",
    }),
  }),
  [STORES.LARGEST_DIRECTORIES]: Object.freeze({
    keyPath: "path",
    indexes: Object.freeze({
      analysisId: "analysisId",
      rankSize: "rankSize",
      rankFileCount: "rankFileCount",
      size: "size",
      fileCount: "fileCount",
    }),
  }),
  [STORES.DUPLICATE_CANDIDATES]: Object.freeze({
    keyPath: "candidateKey",
    indexes: Object.freeze({
      analysisId: "analysisId",
      mode: "mode",
      potentialSavings: "potentialSavings",
      fileCount: "fileCount",
    }),
  }),
  [STORES.DUPLICATE_HASHES]: Object.freeze({
    keyPath: "hashKey",
    indexes: Object.freeze({
      analysisId: "analysisId",
      hash: "hash",
      fileId: "fileId",
      verifiedAt: "verifiedAt",
    }),
  }),
  [STORES.ANALYSIS_HISTORY]: Object.freeze({
    keyPath: "analysisId",
    indexes: Object.freeze({
      analyzedAt: "analyzedAt",
      rootName: "rootName",
      status: "status",
    }),
  }),
  [STORES.HISTORY_FILES]: Object.freeze({
    keyPath: "historyKey",
    indexes: Object.freeze({
      analysisId: "analysisId",
      relativePathLower: "relativePathLower",
      extension: "extension",
      category: "category",
      size: "size",
      lastModified: "lastModified",
    }),
  }),
  [STORES.SAVED_SEARCHES]: Object.freeze({
    keyPath: "id",
    indexes: Object.freeze({
      nameLower: "nameLower",
      order: "order",
      updatedAt: "updatedAt",
    }),
  }),
  [STORES.CLEANUP_RULES]: Object.freeze({
    keyPath: "id",
    indexes: Object.freeze({
      enabled: "enabled",
      updatedAt: "updatedAt",
    }),
  }),
  [STORES.APP_SETTINGS]: Object.freeze({
    keyPath: "key",
    indexes: Object.freeze({
      updatedAt: "updatedAt",
    }),
  }),
  [STORES.PROJECT_DETECTION]: Object.freeze({
    keyPath: "detectionKey",
    indexes: Object.freeze({
      analysisId: "analysisId",
      type: "type",
      score: "score",
    }),
  }),
  [STORES.COMPARISON_RESULTS]: Object.freeze({
    keyPath: "resultKey",
    indexes: Object.freeze({
      comparisonId: "comparisonId",
      status: "status",
      relativePathLower: "relativePathLower",
      createdAt: "createdAt",
    }),
  }),
});

function ensureIndex(store, name, keyPath) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, { unique: false });
  }
}

function ensureStore(database, transaction, name, definition) {
  const store = database.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : database.createObjectStore(name, { keyPath: definition.keyPath });
  Object.entries(definition.indexes).forEach(([indexName, keyPath]) => {
    ensureIndex(store, indexName, keyPath);
  });
  return store;
}

function migrateLegacyRecords(transaction) {
  const metaStore = transaction.objectStore(STORES.ANALYSIS_META);
  const metaRequest = metaStore.get("current");
  metaRequest.onsuccess = () => {
    const legacyMeta = metaRequest.result;
    if (!legacyMeta) {
      return;
    }
    const analysisId = String(
      legacyMeta.analysisId
      || `legacy-${Number(legacyMeta.analyzedAt) || Date.now()}`,
    );
    metaStore.put({
      ...legacyMeta,
      id: "current",
      analysisId,
      status: legacyMeta.status === "saving" ? "processing" : legacyMeta.status,
      schemaVersion: DATA_VERSION,
      dataVersion: DATA_VERSION,
      version: DATA_VERSION,
      migratedFromVersion: Number(legacyMeta.schemaVersion || legacyMeta.dataVersion) || 1,
      requiresReanalysis: true,
    });

    const migrateStore = (storeName, transform) => {
      const request = transaction.objectStore(storeName).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        cursor.update(transform(cursor.value, analysisId));
        cursor.continue();
      };
    };

    migrateStore(STORES.FILES, (row, id) => {
      const relativePath = String(row.relativePath || row.path || row.name || "");
      return {
        ...row,
        analysisId: id,
        relativePath,
        relativePathLower: String(
          row.relativePathLower || row.pathLower || relativePath.toLowerCase(),
        ),
        path: String(row.path || relativePath),
        pathLower: String(row.pathLower || relativePath.toLowerCase()),
        category: String(row.category || "other"),
        depth: Number(row.depth) || Math.max(1, relativePath.split("/").filter(Boolean).length),
      };
    });
    migrateStore(STORES.DIRECTORIES, (row, id) => ({ ...row, analysisId: id }));
    migrateStore(STORES.EXTENSIONS, (row, id) => ({
      ...row,
      analysisId: id,
      category: String(row.category || "other"),
    }));
    migrateStore(STORES.LARGEST_FILES, (row, id) => ({ ...row, analysisId: id }));
    migrateStore(STORES.LARGEST_DIRECTORIES, (row, id) => ({ ...row, analysisId: id }));
  };
}

export function upgradeDatabase(database, transaction, oldVersion) {
  Object.entries(STORE_DEFINITIONS).forEach(([name, definition]) => {
    ensureStore(database, transaction, name, definition);
  });

  if (oldVersion > 0 && oldVersion < DB_VERSION) {
    migrateLegacyRecords(transaction);
  }
}

export const SCHEMA = STORE_DEFINITIONS;
