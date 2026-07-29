export const APP_SCHEMA_VERSION = 4;

export const ANALYSIS_STATUS = Object.freeze({
  PROCESSING: "processing",
  COMPLETE: "complete",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

export const FILE_CATEGORIES = Object.freeze({
  SOURCE_CODE: "source-code",
  DOCUMENT: "document",
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  ARCHIVE: "archive",
  DATA: "data",
  EXECUTABLE: "executable",
  FONT: "font",
  TEMPORARY: "temporary",
  LOG: "log",
  BACKUP: "backup",
  OTHER: "other",
  NO_EXTENSION: "no-extension",
});

export const AGE_BUCKETS = Object.freeze([
  Object.freeze({ key: "within-7-days", label: "7日以内" }),
  Object.freeze({ key: "within-30-days", label: "30日以内" }),
  Object.freeze({ key: "within-90-days", label: "90日以内" }),
  Object.freeze({ key: "within-6-months", label: "半年以内" }),
  Object.freeze({ key: "within-1-year", label: "1年以内" }),
  Object.freeze({ key: "older-than-1-year", label: "1年以上" }),
  Object.freeze({ key: "older-than-3-years", label: "3年以上" }),
  Object.freeze({ key: "unknown", label: "更新日時不明" }),
]);

export const CLEANUP_FLAGS = Object.freeze({
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

export const HEALTH_RULES = Object.freeze({
  duplicateCandidates: Object.freeze({ threshold: 10, maxDeduction: 12 }),
  oldLargeFiles: Object.freeze({ threshold: 5, maxDeduction: 12 }),
  emptyDirectories: Object.freeze({ threshold: 5, maxDeduction: 5 }),
  deepPaths: Object.freeze({ threshold: 10, maxDeduction: 10 }),
  concentratedDirectories: Object.freeze({ threshold: 1, maxDeduction: 8 }),
  longPaths: Object.freeze({ threshold: 10, maxDeduction: 8 }),
  temporaryFiles: Object.freeze({ threshold: 20, maxDeduction: 8 }),
  logFiles: Object.freeze({ threshold: 20, maxDeduction: 6 }),
  backupFiles: Object.freeze({ threshold: 10, maxDeduction: 6 }),
  buildArtifacts: Object.freeze({ threshold: 20, maxDeduction: 8 }),
  noExtensionFiles: Object.freeze({ threshold: 20, maxDeduction: 5 }),
  zeroByteFiles: Object.freeze({ threshold: 20, maxDeduction: 4 }),
});

export const DEFAULT_ANALYSIS_OPTIONS = Object.freeze({
  chunkSize: 2000,
  aggregateWriteChunkSize: 2000,
  topLimit: 5000,
  historyLimit: 5,
  oldFileDays: 365,
  largeFileBytes: 100 * 1024 * 1024,
  veryLargeFileBytes: 1024 * 1024 * 1024,
  longPathLength: 240,
  deepPathDepth: 10,
});
