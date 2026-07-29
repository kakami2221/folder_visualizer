(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common;
  const Storage = app.Storage || app.storage;
  const Analyzer = app.Analyzer || app.analyzer;
  const VirtualFileTable = app.VirtualTable?.VirtualFileTable || app.VirtualFileTable;
  const QUERY_CACHE_LIMIT = 3;
  const MEGABYTE = 1024 * 1024;

  const state = {
    isBusy: false,
    analysisRequestId: 0,
    queryRequestId: 0,
    queryCache: new Map(),
    currentQueryKey: "",
    table: null,
    hasCompleteAnalysis: false,
  };

  const elements = {};

  function captureElements() {
    [
      "analyze-form",
      "folder-input",
      "analyze-button",
      "cancel-button",
      "progress-panel",
      "progress-title",
      "progress-description",
      "progress-percentage",
      "progress-bar",
      "progress-fill",
      "progress-count",
      "progress-stage",
      "form-message",
      "analysis-actions",
      "file-panel",
      "file-name-search",
      "path-search",
      "extension-filter",
      "min-size-filter",
      "max-size-filter",
      "sort-by",
      "sort-direction",
      "filtered-stats",
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    if (elements["analyze-button"]) {
      elements["analyze-button"].textContent = isBusy ? "このフォルダで再解析" : "フォルダを解析";
      elements["analyze-button"].setAttribute("aria-busy", String(isBusy));
    }
    elements["cancel-button"]?.classList.toggle("hidden", !isBusy);
    elements["progress-panel"]?.classList.toggle("hidden", !isBusy);
  }

  function updateProgress(progress = {}) {
    const total = Math.max(0, Number(progress.total) || 0);
    const processed = Math.min(total || Infinity, Math.max(0, Number(progress.processed) || 0));
    const computedPercent = total ? (processed / total) * 100 : 0;
    const percent = Math.min(
      100,
      Math.max(0, Math.round(Number(progress.percent ?? computedPercent) || 0)),
    );
    const stage = progress.stage || "解析中";
    const message = progress.message || progress.description || "フォルダを解析しています。";

    if (elements["progress-panel"]) {
      elements["progress-panel"].classList.remove("hidden");
    }
    if (elements["progress-title"]) {
      elements["progress-title"].textContent = stage;
    }
    if (elements["progress-description"]) {
      elements["progress-description"].textContent = message;
    }
    if (elements["progress-percentage"]) {
      elements["progress-percentage"].textContent = `${percent}%`;
    }
    if (elements["progress-fill"]) {
      elements["progress-fill"].style.width = `${percent}%`;
    }
    if (elements["progress-count"]) {
      elements["progress-count"].textContent = `${Common.formatNumber(processed)} / ${Common.formatNumber(total)} files processed`;
    }
    if (elements["progress-stage"]) {
      elements["progress-stage"].textContent = stage;
    }
    elements["progress-bar"]?.setAttribute("aria-valuenow", String(percent));
  }

  function analysisAvailable(available) {
    state.hasCompleteAnalysis = available;
    Common.setAnalysisAvailability(available);
    elements["analysis-actions"]?.classList.remove("hidden");
    elements["file-panel"]?.classList.toggle("hidden", !available);
  }

  async function refreshAvailabilityAfterError() {
    try {
      const status = await Common.initializeNavigation();
      analysisAvailable(status.available);
      return status.available;
    } catch {
      analysisAvailable(false);
      return false;
    }
  }

  function makeQueryCriteria() {
    const minValue = Number(elements["min-size-filter"]?.value || 0);
    const maxText = elements["max-size-filter"]?.value?.trim() || "";
    const maxValue = maxText === "" ? null : Number(maxText);
    if (
      Number.isFinite(maxValue)
      && maxValue >= 0
      && Number.isFinite(minValue)
      && minValue > maxValue
    ) {
      throw new Error("最大サイズには最小サイズ以上の値を指定してください。");
    }

    const requestedSort = elements["sort-by"]?.value || "size";
    const sortBy = requestedSort === "nameLower" ? "name" : requestedSort;
    const criteria = {
      name: elements["file-name-search"]?.value.trim().toLowerCase() || "",
      path: elements["path-search"]?.value.trim().toLowerCase() || "",
      extension: elements["extension-filter"]?.value || "",
      sortBy,
      direction: elements["sort-direction"]?.value || "desc",
    };
    if (Number.isFinite(minValue) && minValue > 0) {
      criteria.minSize = Math.round(minValue * MEGABYTE);
    }
    if (Number.isFinite(maxValue) && maxValue >= 0) {
      criteria.maxSize = Math.round(maxValue * MEGABYTE);
    }
    return criteria;
  }

  function normalizeQueryResult(result) {
    if (Array.isArray(result)) {
      return {
        ids: result,
        totalCount: result.length,
        totalSize: null,
        cancelled: false,
      };
    }
    return {
      ids: Array.isArray(result?.ids) ? result.ids : [],
      totalCount: Number(result?.totalCount ?? result?.ids?.length) || 0,
      totalSize: Number.isFinite(Number(result?.totalSize))
        ? Number(result.totalSize)
        : null,
      cancelled: Boolean(result?.cancelled),
    };
  }

  function touchQueryCache(key, result) {
    state.queryCache.delete(key);
    state.queryCache.set(key, result);
    while (state.queryCache.size > QUERY_CACHE_LIMIT) {
      state.queryCache.delete(state.queryCache.keys().next().value);
    }
  }

  function showQueryStats(result) {
    if (!elements["filtered-stats"]) {
      return;
    }
    const countText = `${Common.formatNumber(result.totalCount)} files`;
    elements["filtered-stats"].textContent = result.totalSize === null
      ? countText
      : `${countText} / ${Common.formatBytes(result.totalSize)}`;
  }

  async function runQuery({ preserveScroll = false, measureInitial = false } = {}) {
    if (!Storage?.queryFileIds || !state.table) {
      throw new Error("ファイル一覧の検索機能を利用できません。");
    }

    const requestId = ++state.queryRequestId;
    const criteria = makeQueryCriteria();
    const key = JSON.stringify(criteria);
    state.currentQueryKey = key;
    if (elements["form-message"]?.classList.contains("error")) {
      Common.showMessage(elements["form-message"], "", "");
    }

    let result = state.queryCache.get(key);
    if (result) {
      touchQueryCache(key, result);
    } else {
      const rawResult = await Storage.queryFileIds(criteria, {
        sortBy: criteria.sortBy,
        direction: criteria.direction,
        isCancelled: () => requestId !== state.queryRequestId,
        onProgress: (progress) => {
          if (requestId !== state.queryRequestId) {
            return;
          }
          const processed = Number(progress?.processed) || 0;
          const total = Number(progress?.total) || 0;
          elements["filtered-stats"].textContent = total
            ? `検索中: ${Common.formatNumber(processed)} / ${Common.formatNumber(total)}`
            : "検索中...";
        },
      });
      result = normalizeQueryResult(rawResult);
      if (requestId !== state.queryRequestId || result.cancelled) {
        return;
      }
      touchQueryCache(key, result);
    }

    if (requestId !== state.queryRequestId) {
      return;
    }
    showQueryStats(result);
    const render = () => state.table.setData(result.ids, { preserveScroll });
    if (measureInitial) {
      await Common.measureAsync("initial table render", render);
    } else {
      await render();
    }
  }

  function populateExtensions(extensions) {
    const select = elements["extension-filter"];
    if (!select) {
      return;
    }
    const currentValue = select.value;
    const fragment = document.createDocumentFragment();
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "すべて";
    fragment.appendChild(allOption);
    for (const item of extensions || []) {
      const option = document.createElement("option");
      option.value = item.extension;
      option.textContent = item.extension || "(拡張子なし)";
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    if ([...select.options].some((option) => option.value === currentValue)) {
      select.value = currentValue;
    }
  }

  async function showInitialPreview() {
    if (!Storage.getLargestFiles || !state.table) {
      return false;
    }
    try {
      const criteria = makeQueryCriteria();
      const isDefaultView = (
        !criteria.name
        && !criteria.path
        && !criteria.extension
        && criteria.minSize === undefined
        && criteria.maxSize === undefined
        && criteria.sortBy === "size"
        && criteria.direction === "desc"
      );
      if (!isDefaultView) {
        return false;
      }
    } catch {
      return false;
    }
    try {
      const files = await Storage.getLargestFiles();
      const ids = [...new Set(
        (files || [])
          .map((file) => file.id)
          .filter((id) => id !== undefined && id !== null),
      )];
      if (!ids.length) {
        return false;
      }
      if (elements["filtered-stats"]) {
        elements["filtered-stats"].textContent = `全ファイルの索引を準備しています（上位${Common.formatNumber(ids.length)}件を先行表示）`;
      }
      await Common.measureAsync(
        "initial table render",
        () => state.table.setData(ids),
      );
      return true;
    } catch (error) {
      console.warn("ファイル一覧の先行表示を準備できませんでした。", error);
      return false;
    }
  }

  async function loadSavedAnalysis({ initial = false } = {}) {
    const status = await Common.initializeNavigation();
    analysisAvailable(status.available);
    if (!status.available) {
      state.queryRequestId += 1;
      state.queryCache.clear();
      await state.table?.clear();
      return status;
    }

    const extensions = await Storage.getExtensions();
    populateExtensions(extensions);
    const previewShown = initial ? await showInitialPreview() : false;
    await runQuery({
      preserveScroll: !initial || previewShown,
      measureInitial: initial && !previewShown,
    });
    return status;
  }

  async function cancelAnalysis(message = "解析をキャンセルしました。", tone = "warning") {
    if (!state.isBusy) {
      return;
    }
    state.analysisRequestId += 1;
    try {
      await Analyzer?.cancel?.();
    } catch (error) {
      console.error("解析のキャンセル処理に失敗しました。", error);
    } finally {
      setBusy(false);
      updateProgress({
        stage: "キャンセル",
        message,
        processed: 0,
        total: 0,
        percent: 0,
      });
      Common.showMessage(elements["form-message"], message, tone);
      await loadSavedAnalysis().catch(() => refreshAvailabilityAfterError());
    }
  }

  async function startAnalysis(fileList) {
    if (!Analyzer?.analyze) {
      throw new Error("Web Workerによる解析機能を利用できません。");
    }
    if (!fileList?.length) {
      throw new Error("解析するフォルダを選択してください。");
    }
    if (state.isBusy) {
      await cancelAnalysis("前の解析を終了し、新しい解析を開始します。", "warning");
    }

    const requestId = ++state.analysisRequestId;
    state.queryRequestId += 1;
    state.queryCache.clear();
    setBusy(true);
    analysisAvailable(false);
    Common.showMessage(elements["form-message"], "フォルダの解析を開始しました。", "success");
    updateProgress({
      stage: "ファイル情報を準備中",
      message: "選択したファイルのメタデータを準備しています。",
      processed: 0,
      total: fileList.length,
      percent: 0,
    });

    try {
      const result = await Analyzer.analyze(fileList, {
        onProgress: (progress) => {
          if (requestId === state.analysisRequestId) {
            updateProgress(progress);
          }
        },
      });
      if (requestId !== state.analysisRequestId) {
        return;
      }
      updateProgress({
        stage: "完了",
        message: "解析結果をIndexedDBへ保存しました。",
        processed: fileList.length,
        total: fileList.length,
        percent: 100,
      });
      Common.showMessage(elements["form-message"], "フォルダの解析が完了しました。", "success");
      Common.logPerformance({
        "metadata preparation": result?.meta?.metadataDurationMs
          ?? result?.timings?.metadataDurationMs,
        "worker analysis": result?.meta?.analysisDurationMs
          ?? result?.timings?.analysisDurationMs,
        "indexedDB storage": result?.meta?.storageDurationMs
          ?? result?.timings?.storageDurationMs,
        total: result?.meta?.totalDurationMs ?? result?.timings?.totalDurationMs,
      });
      try {
        await loadSavedAnalysis({ initial: true });
      } catch (loadError) {
        console.error("解析結果は保存されましたが、ファイル一覧を表示できませんでした。", loadError);
        await refreshAvailabilityAfterError();
        Common.showMessage(
          elements["form-message"],
          "解析結果は保存されましたが、ファイル一覧を表示できませんでした。分析ページは利用できます。",
          "warning",
        );
      }
    } catch (error) {
      if (requestId !== state.analysisRequestId) {
        return;
      }
      const cancelled = error?.name === "AbortError"
        || /cancel|キャンセル/i.test(error?.message || "");
      const message = cancelled
        ? "解析をキャンセルしました。"
        : (error?.message || "フォルダの解析中にエラーが発生しました。");
      console.error(message, error);
      Common.showMessage(elements["form-message"], message, cancelled ? "warning" : "error");
      updateProgress({
        stage: cancelled ? "キャンセル" : "エラー",
        message,
        processed: 0,
        total: fileList.length,
        percent: 0,
      });
      await loadSavedAnalysis().catch(() => refreshAvailabilityAfterError());
    } finally {
      if (requestId === state.analysisRequestId) {
        setBusy(false);
      }
    }
  }

  function bindEvents() {
    elements["analyze-form"]?.addEventListener("submit", (event) => {
      event.preventDefault();
      const files = elements["folder-input"]?.files;
      void startAnalysis(files).catch((error) => {
        Common.showMessage(elements["form-message"], error.message, "error");
      });
    });

    elements["cancel-button"]?.addEventListener("click", () => {
      void cancelAnalysis();
    });

    elements["folder-input"]?.addEventListener("change", () => {
      if (state.isBusy) {
        void cancelAnalysis(
          "別のフォルダが選択されたため、実行中の解析をキャンセルしました。",
          "warning",
        );
      }
    });

    const debouncedQuery = Common.debounce(() => {
      void runQuery().catch((error) => {
        Common.showMessage(elements["form-message"], error.message, "error");
      });
    }, 250);
    ["file-name-search", "path-search"].forEach((id) => {
      elements[id]?.addEventListener("input", debouncedQuery);
    });
    ["min-size-filter", "max-size-filter"].forEach((id) => {
      elements[id]?.addEventListener("input", debouncedQuery);
    });
    ["extension-filter", "sort-by", "sort-direction"].forEach((id) => {
      elements[id]?.addEventListener("change", () => {
        void runQuery().catch((error) => {
          Common.showMessage(elements["form-message"], error.message, "error");
        });
      });
    });

    window.addEventListener("pagehide", () => {
      if (state.isBusy) {
        void Analyzer?.cancel?.();
      }
    });
  }

  async function initialize() {
    captureElements();
    if (!Common || !Storage || !VirtualFileTable) {
      Common?.showMessage?.(
        elements["form-message"],
        "アプリの初期化に必要な機能を読み込めませんでした。",
        "error",
      );
      return;
    }

    try {
      state.table = new VirtualFileTable({
        getFilesByIds: Storage.getFilesByIds.bind(Storage),
        onError: (error) => {
          Common.showMessage(
            elements["form-message"],
            error?.message || "ファイル一覧の読み込みに失敗しました。",
            "error",
          );
        },
      });
      bindEvents();
      await loadSavedAnalysis({ initial: true });
    } catch (error) {
      console.error("メインページを初期化できませんでした。", error);
      Common.showMessage(
        elements["form-message"],
        error?.message || "メインページを初期化できませんでした。",
        "error",
      );
      if (!state.hasCompleteAnalysis) {
        await refreshAvailabilityAfterError();
      } else {
        analysisAvailable(true);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });

  app.IndexPage = Object.freeze({
    runQuery,
    startAnalysis,
    cancelAnalysis,
    getState: () => ({
      ...state,
      queryCacheSize: state.queryCache.size,
      table: state.table?.getState(),
    }),
  });
})();
