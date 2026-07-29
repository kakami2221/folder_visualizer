(function initializeFolderVisualizerAnalyzerCompatibility(global) {
  "use strict";

  const app = global.FolderVisualizer = global.FolderVisualizer || {};
  const CHUNK_SIZE = 2000;
  const TOP_LIMIT = 5000;
  const AGGREGATE_WRITE_CHUNK_SIZE = 2000;
  const scriptUrl = global.document?.currentScript?.src
    || new URL("/static/js/analyzer.js", global.location.href).href;
  const moduleUrl = new URL("analysis/analyzer.js", scriptUrl).href;
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

  const Analyzer = Object.freeze({
    CHUNK_SIZE,
    TOP_LIMIT,
    AGGREGATE_WRITE_CHUNK_SIZE,
    ready: load,
    analyze: (...args) => load().then((analyzer) => analyzer.analyze(...args)),
    cancel: (...args) => load().then((analyzer) => analyzer.cancel(...args)),
    isRunning: () => implementation?.isRunning() || false,
    getActiveAnalysisId: () => implementation?.getActiveAnalysisId() || null,
    hasSessionFiles: () => implementation?.hasSessionFiles() || false,
    getSessionFile: (...args) => implementation?.getSessionFile(...args) || null,
    getSessionFiles: (...args) => implementation?.getSessionFiles(...args) || [],
    clearSessionFiles: () => implementation?.clearSessionFiles(),
  });
  app.Analyzer = Analyzer;
  app.analyzer = Analyzer;
  void load();
})(window);
