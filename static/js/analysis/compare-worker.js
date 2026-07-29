"use strict";

let state = null;

function normalizedPath(file) {
  return String(file?.relativePathLower || file?.relativePath || file?.pathLower || file?.path || "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function compact(file) {
  return {
    id: file?.id,
    relativePath: String(file?.relativePath || file?.path || ""),
    relativePathLower: normalizedPath(file),
    name: String(file?.name || ""),
    extension: String(file?.extension || ""),
    category: String(file?.category || "other"),
    size: Math.max(0, Number(file?.size) || 0),
    lastModified: Math.max(0, Number(file?.lastModified) || 0),
  };
}

function initialize(message) {
  const requestId = String(message.requestId || "");
  if (!requestId) throw new Error("比較リクエストIDがありません。");
  state = {
    requestId,
    a: new Map(),
    b: new Map(),
    processed: 0,
    expected: Math.max(0, Number(message.totalA) || 0)
      + Math.max(0, Number(message.totalB) || 0),
  };
  self.postMessage({ type: "ready", requestId });
}

function addChunk(message) {
  if (!state || String(message.requestId) !== state.requestId) {
    throw new Error("古い比較結果は無視されました。");
  }
  const target = message.side === "B" ? state.b : state.a;
  const rows = Array.isArray(message.files) ? message.files : [];
  rows.forEach((file) => {
    const row = compact(file);
    if (row.relativePathLower) target.set(row.relativePathLower, row);
    state.processed += 1;
  });
  self.postMessage({
    type: "progress",
    requestId: state.requestId,
    processed: state.processed,
    total: state.expected,
  });
}

function observeDistribution(map, labelKey, label, side, file) {
  const normalizedLabel = String(label || "");
  const row = map.get(normalizedLabel) || {
    [labelKey]: normalizedLabel,
    a: 0,
    b: 0,
    countA: 0,
    countB: 0,
  };
  row[side] += Number(file?.size) || 0;
  row[side === "a" ? "countA" : "countB"] += 1;
  map.set(normalizedLabel, row);
}

function complete(message) {
  if (!state || String(message.requestId) !== state.requestId) {
    throw new Error("古い比較結果は無視されました。");
  }
  const comparisonId = String(message.comparisonId || state.requestId);
  const results = [];
  const extensionDelta = new Map();
  const categoryDelta = new Map();
  let sizeA = 0;
  let sizeB = 0;
  let countB = 0;
  const statusCounts = {
    "only-a": 0,
    "only-b": 0,
    "size-changed": 0,
    "date-changed": 0,
    "likely-same": 0,
  };

  state.a.forEach((left, key) => {
    sizeA += left.size;
    const right = state.b.get(key);
    let status = "only-a";
    if (right) {
      status = left.size !== right.size
        ? "size-changed"
        : left.lastModified !== right.lastModified
          ? "date-changed"
          : "likely-same";
      state.b.delete(key);
      sizeB += right.size;
      countB += 1;
    }
    statusCounts[status] += 1;
    results.push({
      resultKey: `${comparisonId}:${results.length}`,
      comparisonId,
      status,
      relativePath: left.relativePath,
      relativePathLower: key,
      a: left,
      b: right || null,
      sizeDelta: (right?.size || 0) - left.size,
      createdAt: Date.now(),
    });
    observeDistribution(extensionDelta, "extension", left.extension, "a", left);
    observeDistribution(categoryDelta, "category", left.category, "a", left);
    if (right) {
      // A file may keep the same path while changing its extension/category.
      // Attribute each side to its own key instead of silently assigning B to A.
      observeDistribution(extensionDelta, "extension", right.extension, "b", right);
      observeDistribution(categoryDelta, "category", right.category, "b", right);
    }
  });
  state.b.forEach((right, key) => {
    sizeB += right.size;
    countB += 1;
    statusCounts["only-b"] += 1;
    results.push({
      resultKey: `${comparisonId}:${results.length}`,
      comparisonId,
      status: "only-b",
      relativePath: right.relativePath,
      relativePathLower: key,
      a: null,
      b: right,
      sizeDelta: right.size,
      createdAt: Date.now(),
    });
    observeDistribution(extensionDelta, "extension", right.extension, "b", right);
    observeDistribution(categoryDelta, "category", right.category, "b", right);
  });
  const summary = {
    comparisonId,
    countA: state.a.size,
    countB,
    sizeA,
    sizeB,
    sizeDelta: sizeB - sizeA,
    statusCounts,
    extensionDelta: [...extensionDelta.values()].map((row) => ({
      ...row,
      delta: row.b - row.a,
      countDelta: row.countB - row.countA,
    })),
    categoryDelta: [...categoryDelta.values()].map((row) => ({
      ...row,
      delta: row.b - row.a,
      countDelta: row.countB - row.countA,
    })),
  };
  self.postMessage({ type: "result", requestId: state.requestId, results, summary });
  state = null;
}

self.onmessage = (event) => {
  const message = event.data || {};
  try {
    if (message.type === "init") initialize(message);
    else if (message.type === "chunk") addChunk(message);
    else if (message.type === "complete") complete(message);
    else if (message.type === "cancel") state = null;
    else throw new Error("未対応の比較処理です。");
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: String(message.requestId || ""),
      message: error instanceof Error ? error.message : "フォルダ比較に失敗しました。",
    });
  }
};
