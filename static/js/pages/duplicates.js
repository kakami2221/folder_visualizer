import {
  Storage,
  byId,
  createElement,
  ensureAnalysis,
  formatBytes,
  formatNumber,
  initializeWhenReady,
  measured,
  setText,
  showMessage,
} from "./page-utils.js";

const MODE_MAP = Object.freeze({
  size: "same-size",
  "name-size": "same-name-size",
  "name-size-date": "same-name-size-modified",
});

const state = {
  meta: null,
  groups: [],
  selected: new Set(),
  worker: null,
  hashRequestId: "",
};

function groupTitle(group) {
  const member = group.members?.[0];
  if (group.mode === "same-size") {
    return `同一サイズ ${formatBytes(member?.size || group.totalSize / group.fileCount)}`;
  }
  return member?.name || "同名ファイル候補";
}

function renderGroups() {
  const target = byId("duplicate-groups");
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  const displayGroups = state.groups.slice(0, 500);
  displayGroups.forEach((group) => {
    const checkbox = createElement("input", {
      type: "checkbox",
      dataset: { candidateKey: group.candidateKey },
      attributes: { "aria-label": `${groupTitle(group)}を精密確認対象にする` },
    });
    checkbox.checked = state.selected.has(group.candidateKey);
    const title = createElement("h3", { text: groupTitle(group) });
    const header = createElement("div", { className: "stack-card-header" }, [
      createElement("label", { className: "checkbox-label" }, [
        checkbox,
        createElement("span", { text: "精密確認対象" }),
      ]),
      createElement("span", {
        className: "tag tag-warning",
        text: `推定削減 ${formatBytes(group.potentialSavings)}`,
      }),
    ]);
    const members = createElement("ul", { className: "metric-list" });
    (group.members || []).slice(0, 12).forEach((member) => {
      members.appendChild(createElement("li", {}, [
        createElement("span", {
          text: member.relativePath,
          title: member.relativePath,
        }),
        createElement("strong", { text: formatBytes(member.size) }),
      ]));
    });
    if (group.truncated || Number(group.fileCount) > (group.members?.length || 0)) {
      members.appendChild(createElement("li", {}, [
        createElement("span", { text: "ほかの候補（表示を省略）" }),
        createElement("strong", {
          text: `${formatNumber(Number(group.fileCount) - (group.members?.length || 0))}件`,
        }),
      ]));
    }
    const card = createElement("article", { className: "stack-card" }, [
      title,
      header,
      createElement("div", { className: "stack-card-meta" }, [
        createElement("span", { text: `${formatNumber(group.fileCount)}ファイル` }),
        createElement("span", { text: `合計 ${formatBytes(group.totalSize)}` }),
        createElement("span", { text: `判定: ${group.mode}` }),
      ]),
      members,
    ]);
    fragment.appendChild(card);
  });
  if (!displayGroups.length) {
    fragment.appendChild(createElement("p", {
      className: "empty-copy",
      text: "現在の条件では重複候補が見つかりませんでした。",
    }));
  }
  target.replaceChildren(fragment);
  setText(
    "duplicate-stats",
    `${formatNumber(state.groups.length)}グループ / 推定削減 ${formatBytes(state.groups.reduce((sum, group) => sum + Number(group.potentialSavings || 0), 0))}`,
  );
}

async function loadGroups() {
  const mode = MODE_MAP[byId("duplicate-mode")?.value] || "same-name-size";
  const minimum = Math.max(0, Number(byId("duplicate-min-size")?.value) || 0) * 1024;
  state.groups = (await measured(
    "duplicate candidate extraction",
    () => Storage.getDuplicateCandidates(mode),
  )).filter((group) => Number(group.members?.[0]?.size || 0) >= minimum);
  state.selected.clear();
  renderGroups();
}

function normalizeSelectedPath(file) {
  const parts = String(file.webkitRelativePath || file.name || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  return (parts.length > 1 ? parts.slice(1) : parts).join("/");
}

function selectedMembers() {
  const byIdentity = new Map();
  state.groups
    .filter((group) => state.selected.has(group.candidateKey))
    .flatMap((group) => group.members || [])
    .forEach((member) => {
      const key = `${member.relativePath}\u0000${member.size}`;
      byIdentity.set(key, member);
    });
  return [...byIdentity.values()];
}

function matchSelectedFiles(fileList, members) {
  const memberByPath = new Map(
    members.map((member) => [`${member.relativePath}\u0000${member.size}`, member]),
  );
  const tasks = [];
  for (const file of fileList || []) {
    const relativePath = normalizeSelectedPath(file);
    const member = memberByPath.get(`${relativePath}\u0000${file.size}`);
    if (member) {
      tasks.push({
        id: member.id,
        relativePath,
        file,
      });
      memberByPath.delete(`${relativePath}\u0000${file.size}`);
    }
  }
  return { tasks, missing: [...memberByPath.values()] };
}

function setHashBusy(busy) {
  byId("hash-start").disabled = busy;
  byId("hash-file-input").disabled = busy;
  byId("hash-cancel")?.classList.toggle("hidden", !busy);
}

function renderHashResults(results) {
  const target = byId("hash-results");
  if (!target) {
    return;
  }
  const byHash = new Map();
  results.filter((row) => row.hash).forEach((row) => {
    const group = byHash.get(row.hash) || [];
    group.push(row);
    byHash.set(row.hash, group);
  });
  const fragment = document.createDocumentFragment();
  [...byHash.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .forEach(([hash, rows]) => {
      const exact = rows.length >= 2;
      const list = createElement("ul", { className: "metric-list" });
      rows.forEach((row) => {
        list.appendChild(createElement("li", {}, [
          createElement("span", { text: row.relativePath, title: row.relativePath }),
          createElement("strong", { text: formatBytes(row.size) }),
        ]));
      });
      fragment.appendChild(createElement("article", { className: "stack-card" }, [
        createElement("div", { className: "stack-card-header" }, [
          createElement("h3", {
            text: exact ? "内容が一致したファイル" : "一致相手なし",
          }),
          createElement("span", {
            className: exact ? "tag tag-warning" : "tag",
            text: `${formatNumber(rows.length)}件`,
          }),
        ]),
        createElement("p", { className: "mono", text: `SHA-256: ${hash}` }),
        list,
      ]));
    });
  results.filter((row) => row.error).forEach((row) => {
    fragment.appendChild(createElement("article", { className: "stack-card" }, [
      createElement("h3", { text: row.relativePath }),
      createElement("p", { text: row.error }),
    ]));
  });
  target.replaceChildren(fragment);
}

async function startHashing() {
  const members = selectedMembers();
  if (!members.length) {
    throw new Error("精密確認する候補グループを選択してください。");
  }
  const fileList = byId("hash-file-input")?.files;
  if (!fileList?.length) {
    throw new Error("候補ファイルを含むフォルダを選択してください。");
  }
  const { tasks, missing } = matchSelectedFiles(fileList, members);
  if (tasks.length < 2) {
    throw new Error("候補に一致するファイルを2件以上確認できませんでした。選択フォルダを確認してください。");
  }
  if (tasks.length > 1000) {
    throw new Error("一度に精密確認できるファイルは1000件までです。候補グループを絞ってください。");
  }

  state.hashRequestId = crypto.randomUUID?.() || `${Date.now()}`;
  state.worker?.terminate();
  state.worker = new Worker(
    new URL("../analysis/duplicate-worker.js", import.meta.url),
    { type: "module", name: "duplicate-sha256" },
  );
  setHashBusy(true);
  showMessage(
    "hash-progress",
    missing.length
      ? `${formatNumber(missing.length)}件は再選択したフォルダ内で見つからなかったため、見つかった候補だけ確認します。`
      : "SHA-256精密確認を開始します。",
    missing.length ? "warning" : "",
  );
  const requestId = state.hashRequestId;
  const startedAt = performance.now();
  performance.mark(`hash:${requestId}:start`);

  const result = await new Promise((resolve, reject) => {
    state.worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.requestId !== requestId) {
        return;
      }
      if (message.type === "progress") {
        const percent = message.totalBytes > 0
          ? Math.min(100, message.completedBytes / message.totalBytes * 100)
          : message.totalFiles > 0
            ? message.completedFiles / message.totalFiles * 100
            : 100;
        showMessage(
          "hash-progress",
          `精密確認中 ${percent.toFixed(1)}%・${formatNumber(message.completedFiles)} / ${formatNumber(message.totalFiles)}件・${message.currentPath || ""}`,
        );
      } else if (message.type === "result") {
        resolve(message.results || []);
      } else if (message.type === "cancelled") {
        const error = new Error("精密確認をキャンセルしました。");
        error.name = "AbortError";
        reject(error);
      } else if (message.type === "error") {
        reject(new Error(message.message || "精密確認に失敗しました。"));
      }
    };
    state.worker.onerror = (event) => {
      reject(new Error(event.message || "SHA-256用Workerでエラーが発生しました。"));
    };
    state.worker.postMessage({ type: "hash", requestId, tasks });
  });

  const finishedAt = Date.now();
  const records = result.map((row) => ({
    ...row,
    hashKey: `${state.meta.analysisId}:${String(row.id)}:${row.hash || "failed"}`,
    analysisId: state.meta.analysisId,
    fileId: row.id,
    verifiedAt: finishedAt,
  }));
  await Storage.saveDuplicateHashes(records);
  performance.mark(`hash:${requestId}:end`);
  performance.measure("hash calculation", `hash:${requestId}:start`, `hash:${requestId}:end`);
  renderHashResults(result);
  showMessage(
    "hash-progress",
    `${formatNumber(result.length)}件の精密確認が完了しました（${((performance.now() - startedAt) / 1000).toFixed(1)}秒）。`,
    "success",
  );
}

function cancelHashing() {
  if (!state.worker || !state.hashRequestId) {
    return;
  }
  state.worker.postMessage({ type: "cancel", requestId: state.hashRequestId });
  window.setTimeout(() => state.worker?.terminate(), 50);
  state.hashRequestId = "";
  setHashBusy(false);
  showMessage("hash-progress", "精密確認をキャンセルしました。", "warning");
}

function bindEvents() {
  byId("duplicate-controls")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void loadGroups().catch((error) => showMessage("page-message", error.message, "error"));
  });
  byId("duplicate-groups")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-candidate-key]");
    if (!checkbox) {
      return;
    }
    if (checkbox.checked) {
      state.selected.add(checkbox.dataset.candidateKey);
    } else {
      state.selected.delete(checkbox.dataset.candidateKey);
    }
  });
  byId("hash-start")?.addEventListener("click", () => {
    void startHashing()
      .catch((error) => {
        showMessage(
          "hash-progress",
          error?.name === "AbortError" ? "精密確認をキャンセルしました。" : error.message,
          error?.name === "AbortError" ? "warning" : "error",
        );
      })
      .finally(() => {
        state.worker?.terminate();
        state.worker = null;
        state.hashRequestId = "";
        setHashBusy(false);
      });
  });
  byId("hash-cancel")?.addEventListener("click", cancelHashing);
}

async function initialize() {
  const status = await ensureAnalysis();
  if (!status.available) {
    return;
  }
  state.meta = status.meta;
  bindEvents();
  await loadGroups();
}

initializeWhenReady(initialize);

export { matchSelectedFiles, normalizeSelectedPath };
