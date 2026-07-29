(function initializeFolderVisualizerStorageCompatibility(global) {
  "use strict";

  const app = global.FolderVisualizer = global.FolderVisualizer || {};
  const DB_NAME = "folder-visualizer-db";
  const DB_VERSION = 4;
  const DATA_VERSION = 4;

  // Synchronous constants preserve the original classic-script API while the
  // implementation is loaded as ES Modules from storage/index.js.
  const STORES = Object.freeze({
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

  const scriptUrl = global.document?.currentScript?.src
    || new URL("/static/js/storage.js", global.location.href).href;
  const moduleUrl = new URL("storage/index.js", scriptUrl).href;
  let modulePromise = null;
  let implementation = null;

  function load() {
    if (!modulePromise) {
      modulePromise = import(moduleUrl).then((module) => {
        implementation = module.default;
        return implementation;
      });
    }
    return modulePromise;
  }

  const asynchronousMethods = [
    "openDatabase",
    "closeDatabase",
    "getAllRecords",
    "getRecordsByIndex",
    "getAnalysisStatus",
    "getCompleteMeta",
    "readCurrentMeta",
    "beginAnalysis",
    "putFileChunk",
    "putRecords",
    "completeAnalysis",
    "cancelAnalysis",
    "failAnalysis",
    "markAnalysisStatus",
    "clearAnalysis",
    "getExtensions",
    "getDirectories",
    "getAgeBuckets",
    "getLargestFiles",
    "getLargestDirectories",
    "getDuplicateCandidates",
    "getDuplicateHashes",
    "getProjectDetection",
    "queryFileIds",
    "getFilesByIds",
    "getFileRange",
    "createHistorySnapshot",
    "listHistory",
    "getHistoryFiles",
    "deleteHistory",
    "clearHistory",
    "pruneHistory",
    "getSetting",
    "getSettings",
    "saveSetting",
    "saveSettings",
    "listSavedSearches",
    "createSavedSearch",
    "renameSavedSearch",
    "deleteSavedSearch",
    "reorderSavedSearches",
    "saveCleanupRules",
    "getCleanupRules",
    "saveDuplicateHashes",
    "saveComparisonResults",
    "getComparisonResults",
    "clearComparisonResults",
  ];

  const facade = {
    DB_NAME,
    DB_VERSION,
    DATA_VERSION,
    STORES,
    ready: load,
  };
  asynchronousMethods.forEach((name) => {
    facade[name] = (...args) => load().then((storage) => storage[name](...args));
  });

  const Storage = Object.freeze(facade);
  app.Storage = Storage;
  app.storage = Storage;
  void load();
})(window);
