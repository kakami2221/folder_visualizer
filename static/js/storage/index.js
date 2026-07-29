import { LruRangeCache } from "./cache.js";
import {
  closeDatabase,
  createStorageError,
  openDatabase,
} from "./database.js";
import * as repositories from "./repositories.js";

export * from "./cache.js";
export * from "./database.js";
export * from "./migrations.js";
export * from "./repositories.js";
// These names are exported by both migrations.js and repositories.js. An
// explicit re-export prevents `export *` ambiguity for named-import callers.
export {
  CURRENT_ANALYSIS_STORES,
  DATA_VERSION,
  DB_NAME,
  DB_VERSION,
  SCHEMA,
  STORES,
  WRITABLE_RECORD_STORES,
} from "./migrations.js";

const Storage = Object.freeze({
  ...repositories,
  LruRangeCache,
  closeDatabase,
  createStorageError,
  openDatabase,
});

if (typeof window !== "undefined") {
  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  app.Storage = Storage;
  app.storage = Storage;
}

export default Storage;
