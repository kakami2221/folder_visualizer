import {
  CLEANUP_FLAGS,
  DEFAULT_ANALYSIS_OPTIONS,
  HEALTH_RULES,
} from "../common/constants.js";
import {
  Storage,
  createElement,
  ensureAnalysis,
  forEachCurrentFile,
  formatNumber,
  initializeWhenReady,
  measured,
  requirePlotly,
  setText,
  showMessage,
} from "./page-utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const RULE_DETAILS = Object.freeze({
  duplicateCandidates: Object.freeze({ label: "重複候補が多い" }),
  oldLargeFiles: Object.freeze({ label: "古い大容量ファイルが多い" }),
  emptyDirectories: Object.freeze({ label: "空フォルダが多い", excluded: true }),
  deepPaths: Object.freeze({ label: "深すぎる階層が多い" }),
  concentratedDirectories: Object.freeze({
    label: "ファイルが集中しているフォルダがある",
  }),
  longPaths: Object.freeze({ label: "長すぎるパスが多い" }),
  temporaryFiles: Object.freeze({ label: "一時ファイル候補が多い" }),
  logFiles: Object.freeze({ label: "ログファイルが多い" }),
  backupFiles: Object.freeze({ label: "バックアップ候補が多い" }),
  buildArtifacts: Object.freeze({ label: "ビルド生成物が多い" }),
  noExtensionFiles: Object.freeze({ label: "拡張子なしファイルが多い" }),
  zeroByteFiles: Object.freeze({ label: "0バイトファイルが多い" }),
});

const EMPTY_DIRECTORY_LIMITATION =
  "ブラウザのフォルダ選択では空フォルダを取得できないため、空フォルダは採点対象外です。";

function nonNegativeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Calculate the health score without reading DOM or browser storage.
 *
 * A rule reaches its maximum deduction at `threshold`; values above the
 * threshold stay capped. Empty directories are intentionally excluded because
 * `<input webkitdirectory>` does not expose them reliably.
 */
export function calculateHealthScore(metrics = {}, rules = HEALTH_RULES) {
  const normalizedMetrics = {};
  const deductions = [];
  let totalDeduction = 0;

  Object.entries(rules || {}).forEach(([key, rule]) => {
    const count = nonNegativeCount(metrics[key]);
    normalizedMetrics[key] = count;
    const details = RULE_DETAILS[key] || { label: key };
    if (details.excluded || count === 0) {
      return;
    }
    const threshold = Math.max(1, nonNegativeCount(rule?.threshold) || 1);
    const maxDeduction = Math.max(
      0,
      Number.isFinite(Number(rule?.maxDeduction))
        ? Number(rule.maxDeduction)
        : 0,
    );
    if (maxDeduction === 0) {
      return;
    }
    const points = Math.min(
      maxDeduction,
      Math.max(1, Math.ceil((count / threshold) * maxDeduction)),
    );
    totalDeduction += points;
    deductions.push({
      key,
      label: details.label,
      count,
      threshold,
      points,
      maxDeduction,
    });
  });

  return {
    score: Math.max(0, Math.min(100, 100 - totalDeduction)),
    totalDeduction,
    deductions,
    metrics: normalizedMetrics,
    limitations: [EMPTY_DIRECTORY_LIMITATION],
  };
}

function cleanupCount(file, flag, fallback) {
  const mask = Number(file.cleanupMask) || 0;
  return (mask & flag) !== 0 || fallback(file);
}

function addFileMetrics(metrics, file, options) {
  const extension = String(file.extension || "").toLowerCase();
  const category = String(file.category || "");
  const name = String(file.nameLower || file.name || "").toLowerCase();
  const path = String(file.relativePath || file.path || "");
  const pathLower = path.toLowerCase();
  const size = Math.max(0, Number(file.size) || 0);
  const lastModified = Math.max(0, Number(file.lastModified) || 0);
  const depth = Math.max(0, Number(file.depth) || 0);
  const age = lastModified > 0 ? Math.max(0, options.referenceTime - lastModified) : 0;

  if (cleanupCount(file, CLEANUP_FLAGS.OLD_LARGE, () => (
    lastModified > 0
    && age >= options.oldFileDays * DAY_MS
    && size >= options.largeFileBytes
  ))) {
    metrics.oldLargeFiles += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.DEEP_PATH, () => depth > options.deepPathDepth)) {
    metrics.deepPaths += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.LONG_PATH, () => (
    path.length > options.longPathLength
  ))) {
    metrics.longPaths += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.TEMPORARY, () => (
    category === "temporary"
    || [".tmp", ".temp", ".swp", ".swo", ".part", ".crdownload"].includes(extension)
    || /(?:^|[._-])(?:tmp|temp|cache)(?:$|[._-])/iu.test(name)
  ))) {
    metrics.temporaryFiles += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.LOG, () => (
    category === "log" || extension === ".log"
  ))) {
    metrics.logFiles += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.BACKUP, () => (
    category === "backup"
    || [".bak", ".backup", ".old", ".orig", ".save"].includes(extension)
  ))) {
    metrics.backupFiles += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.BUILD_ARTIFACT, () => (
    /(?:^|\/)(?:node_modules|dist|build|target|out|coverage|\.next)(?:\/|$)/iu
      .test(pathLower)
  ))) {
    metrics.buildArtifacts += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.NO_EXTENSION, () => (
    !extension || extension === "(no extension)"
  ))) {
    metrics.noExtensionFiles += 1;
  }
  if (cleanupCount(file, CLEANUP_FLAGS.ZERO_BYTE, () => size === 0)) {
    metrics.zeroByteFiles += 1;
  }
}

export async function collectHealthMetrics(meta, options = {}) {
  const metrics = Object.fromEntries(
    Object.keys(HEALTH_RULES).map((key) => [key, 0]),
  );
  const settings = options.settings || await Storage.getSettings();
  const scanOptions = {
    referenceTime: Math.max(0, Number(meta?.analyzedAt) || Date.now()),
    oldFileDays: Math.max(
      1,
      Number(settings.oldFileDays) || DEFAULT_ANALYSIS_OPTIONS.oldFileDays,
    ),
    largeFileBytes: Math.max(
      1,
      (Number(settings.largeFileMb) || 100) * 1024 * 1024,
    ),
    deepPathDepth: Math.max(
      1,
      Number(settings.deepPathDepth) || DEFAULT_ANALYSIS_OPTIONS.deepPathDepth,
    ),
    longPathLength: Math.max(
      20,
      Number(settings.longPathLength) || DEFAULT_ANALYSIS_OPTIONS.longPathLength,
    ),
  };

  await forEachCurrentFile((rows) => {
    rows.forEach((file) => addFileMetrics(metrics, file, scanOptions));
  }, {
    chunkSize: 2000,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
  });

  const [directories, duplicateCandidates] = await Promise.all([
    Storage.getDirectories(),
    Storage.getDuplicateCandidates("same-name-size"),
  ]);
  metrics.duplicateCandidates = duplicateCandidates.length;
  const totalFiles = Math.max(0, Number(meta?.totalFiles) || 0);
  metrics.concentratedDirectories = directories.filter((directory) => (
    directory.path !== meta?.rootName
    && (
      Number(directory.directFileCount) >= 1000
      || (
        totalFiles >= 100
        && Number(directory.directFileCount) / totalFiles >= 0.25
      )
    )
  )).length;

  // Empty folders cannot be discovered by webkitdirectory. Even if a legacy
  // record contains zero-file directories, the metric remains excluded.
  metrics.emptyDirectories = 0;
  return metrics;
}

function normalizeStoredHealth(health) {
  const score = Number(health?.score);
  if (!Number.isFinite(score)) {
    return null;
  }
  const metrics = health.metrics || {};
  const deductions = Array.isArray(health.deductions)
    ? health.deductions.map((deduction) => {
      const rule = HEALTH_RULES[deduction.key] || {};
      return {
        key: String(deduction.key || ""),
        label: String(
          deduction.label
          || RULE_DETAILS[deduction.key]?.label
          || deduction.key
          || "減点項目",
        ),
        count: nonNegativeCount(deduction.count ?? metrics[deduction.key]),
        threshold: Math.max(1, nonNegativeCount(
          deduction.threshold ?? rule.threshold,
        ) || 1),
        points: Math.max(0, Number(deduction.points) || 0),
        maxDeduction: Math.max(
          0,
          Number(deduction.maxDeduction ?? rule.maxDeduction) || 0,
        ),
      };
    })
    : [];
  return {
    ...health,
    score: Math.max(0, Math.min(100, score)),
    totalDeduction: deductions.reduce((sum, item) => sum + item.points, 0),
    deductions,
    metrics,
    limitations: [...new Set([
      ...(Array.isArray(health.limitations) ? health.limitations : []),
      EMPTY_DIRECTORY_LIMITATION,
    ])],
  };
}

function scoreSummary(score) {
  if (score >= 90) return "整理上の大きな偏りは少なく、良好な状態です。";
  if (score >= 75) return "おおむね良好ですが、いくつか確認できる候補があります。";
  if (score >= 50) return "整理を検討できる候補が複数あります。減点理由を確認してください。";
  return "確認をおすすめする候補が多くあります。優先度の高い項目から確認してください。";
}

function renderReasons(result) {
  const target = document.getElementById("health-reasons");
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  if (result.deductions.length === 0) {
    fragment.appendChild(createElement("article", { className: "stack-card" }, [
      createElement("h3", { text: "減点項目はありません" }),
      createElement("p", {
        text: "現在取得できるメタデータの範囲では、大きな整理上の偏りを検出しませんでした。",
      }),
    ]));
  } else {
    result.deductions.forEach((deduction) => {
      fragment.appendChild(createElement("article", { className: "stack-card" }, [
        createElement("div", { className: "stack-card-header" }, [
          createElement("h3", { text: deduction.label }),
          createElement("span", {
            className: "tag tag-warning",
            text: `-${formatNumber(deduction.points)}点`,
          }),
        ]),
        createElement("p", {
          text: `検出 ${formatNumber(deduction.count)}件 / 最大減点の基準 ${formatNumber(deduction.threshold)}件 / 上限 -${formatNumber(deduction.maxDeduction)}点`,
        }),
      ]));
    });
  }
  result.limitations.forEach((limitation) => {
    fragment.appendChild(createElement("article", { className: "stack-card" }, [
      createElement("h3", { text: "採点上の制約" }),
      createElement("p", { text: limitation }),
    ]));
  });
  target.replaceChildren(fragment);
}

async function renderGauge(score) {
  const Plotly = await requirePlotly();
  const chart = document.getElementById("health-chart");
  if (!chart) {
    return;
  }
  await measured("health score", () => Plotly.react(chart, [{
    type: "indicator",
    mode: "gauge+number",
    value: score,
    number: { suffix: " / 100", font: { color: "#1f2523" } },
    gauge: {
      axis: { range: [0, 100], tickwidth: 1 },
      bar: { color: score >= 75 ? "#2f7d61" : score >= 50 ? "#bf7a2d" : "#b5463c" },
      bgcolor: "#eef1ee",
      borderwidth: 0,
      steps: [
        { range: [0, 50], color: "#f5d9d6" },
        { range: [50, 75], color: "#f7ead2" },
        { range: [75, 100], color: "#dcece5" },
      ],
      threshold: {
        line: { color: "#1f2523", width: 3 },
        thickness: 0.75,
        value: score,
      },
    },
  }], {
    margin: { t: 30, r: 30, b: 20, l: 30 },
    paper_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#1f2523" },
  }, {
    responsive: true,
    displayModeBar: false,
  }));
}

export async function initializeHealthScorePage() {
  const status = await ensureAnalysis();
  if (!status.available && !status.usable) {
    return;
  }
  const meta = status.meta || await Storage.getCompleteMeta();
  if (!meta) {
    throw new Error("健康診断に利用できる解析結果がありません。");
  }

  let result = normalizeStoredHealth(meta.health);
  if (!result) {
    showMessage("page-message", "健康診断用データを再計算しています。");
    const metrics = await measured(
      "health score fallback",
      () => collectHealthMetrics(meta),
    );
    result = calculateHealthScore(metrics);
  }

  setText("health-score-value", formatNumber(result.score));
  setText("health-summary", scoreSummary(result.score));
  renderReasons(result);
  await renderGauge(result.score);
  showMessage(
    "page-message",
    "診断結果は整理候補を見つけるための目安です。ファイル削除は行いません。",
    "success",
  );
}

initializeWhenReady(initializeHealthScorePage);

export {
  EMPTY_DIRECTORY_LIMITATION,
  RULE_DETAILS,
  normalizeStoredHealth,
};
