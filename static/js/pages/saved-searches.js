import {
  Storage,
  byId,
  createElement,
  initializeWhenReady,
  showMessage,
} from "./page-utils.js";

const state = {
  searches: [],
  busy: false,
};

function optionalNumber(id, label) {
  const raw = String(byId(id)?.value || "").trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}には0以上の数値を入力してください。`);
  }
  return value;
}

function readCriteria() {
  const name = String(byId("saved-file-name")?.value || "").trim();
  const path = String(byId("saved-path")?.value || "").trim();
  const minSizeMb = optionalNumber("saved-min-size", "最小サイズ");
  const maxSizeMb = optionalNumber("saved-max-size", "最大サイズ");
  const dateFrom = String(byId("saved-date-from")?.value || "");
  const dateTo = String(byId("saved-date-to")?.value || "");
  const useRegex = Boolean(byId("saved-regex")?.checked);

  if (minSizeMb !== null && maxSizeMb !== null && minSizeMb > maxSizeMb) {
    throw new Error("最大サイズには最小サイズ以上の値を指定してください。");
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error("更新日の終了日は開始日以降を指定してください。");
  }
  if (useRegex && name) {
    try {
      void new RegExp(name, "iu");
    } catch {
      throw new Error("正規表現が正しくありません。入力内容を確認してください。");
    }
  }

  const requestedSort = String(byId("saved-sort")?.value || "size");
  return {
    name,
    path,
    extension: String(byId("saved-extension")?.value || "").trim(),
    category: String(byId("saved-category")?.value || ""),
    minSizeMb,
    maxSizeMb,
    dateFrom,
    dateTo,
    sortBy: requestedSort === "name" ? "nameLower" : requestedSort,
    direction: String(byId("saved-direction")?.value || "desc"),
    useRegex,
  };
}

function describeCriteria(criteria = {}) {
  const descriptions = [];
  if (criteria.name) descriptions.push(`名前: ${criteria.name}`);
  if (criteria.path) descriptions.push(`パス: ${criteria.path}`);
  if (criteria.extension) descriptions.push(`拡張子: ${criteria.extension}`);
  if (criteria.category) descriptions.push(`カテゴリ: ${criteria.category}`);
  if (Number.isFinite(criteria.minSizeMb)) {
    descriptions.push(`最小: ${criteria.minSizeMb} MB`);
  }
  if (Number.isFinite(criteria.maxSizeMb)) {
    descriptions.push(`最大: ${criteria.maxSizeMb} MB`);
  }
  if (criteria.dateFrom) descriptions.push(`更新日: ${criteria.dateFrom}以降`);
  if (criteria.dateTo) descriptions.push(`更新日: ${criteria.dateTo}以前`);
  if (criteria.useRegex) descriptions.push("正規表現");
  descriptions.push(
    `並び順: ${criteria.sortBy || "size"} / ${criteria.direction === "asc" ? "昇順" : "降順"}`,
  );
  return descriptions.join("・");
}

function applicationUrl(id) {
  const parameters = new URLSearchParams({ savedSearch: String(id) });
  return `/?${parameters.toString()}`;
}

function actionButton(label, action, id, disabled = false) {
  const button = createElement("button", {
    className: "secondary-button",
    text: label,
    type: "button",
    dataset: { action, searchId: id },
  });
  button.disabled = disabled;
  return button;
}

function renderSearch(search, index) {
  const title = createElement("h3", { text: search.name });
  const applyLink = createElement("a", {
    className: "primary-link",
    text: "メインページへ適用",
    href: applicationUrl(search.id),
  });
  const header = createElement("div", { className: "stack-card-header" }, [
    title,
    applyLink,
  ]);
  const description = createElement("p", {
    text: describeCriteria(search.criteria),
  });
  const actions = createElement("div", { className: "inline-actions" }, [
    actionButton("名前を変更", "rename", search.id),
    actionButton("上へ", "up", search.id, index === 0),
    actionButton("下へ", "down", search.id, index === state.searches.length - 1),
    actionButton("削除", "delete", search.id),
  ]);
  return createElement("article", {
    className: "stack-card",
    dataset: { searchId: search.id },
  }, [header, description, actions]);
}

function render() {
  const target = byId("saved-search-list");
  const empty = byId("saved-search-empty");
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  state.searches.forEach((search, index) => {
    fragment.appendChild(renderSearch(search, index));
  });
  target.replaceChildren(fragment);
  empty?.classList.toggle("hidden", state.searches.length > 0);
}

async function reload() {
  state.searches = await Storage.listSavedSearches();
  render();
}

async function createSearch() {
  const requestedName = String(byId("saved-name")?.value || "").trim();
  if (!requestedName) {
    throw new Error("保存する検索条件の名前を入力してください。");
  }
  const created = await Storage.createSavedSearch(requestedName, readCriteria());
  byId("saved-search-form")?.reset();
  await reload();
  showMessage(
    "page-message",
    created.name === requestedName
      ? `「${created.name}」を保存しました。`
      : `同じ名前があるため「${created.name}」として保存しました。`,
    "success",
  );
}

async function renameSearch(id) {
  const current = state.searches.find((search) => String(search.id) === String(id));
  if (!current) {
    return;
  }
  const requestedName = window.prompt("新しい名前を入力してください。", current.name);
  if (requestedName === null) {
    return;
  }
  if (!requestedName.trim()) {
    throw new Error("保存済み検索の名前を入力してください。");
  }
  const renamed = await Storage.renameSavedSearch(id, requestedName);
  await reload();
  showMessage(
    "page-message",
    renamed.name === requestedName.trim()
      ? `「${renamed.name}」へ名前を変更しました。`
      : `同じ名前があるため「${renamed.name}」へ変更しました。`,
    "success",
  );
}

async function deleteSearch(id) {
  const current = state.searches.find((search) => String(search.id) === String(id));
  if (!current || !window.confirm(`保存済み検索「${current.name}」を削除しますか？`)) {
    return;
  }
  await Storage.deleteSavedSearch(id);
  await reload();
  showMessage("page-message", "保存済み検索を削除しました。", "success");
}

async function moveSearch(id, delta) {
  const index = state.searches.findIndex((search) => String(search.id) === String(id));
  const destination = index + delta;
  if (index < 0 || destination < 0 || destination >= state.searches.length) {
    return;
  }
  const ordered = [...state.searches];
  [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
  state.searches = await Storage.reorderSavedSearches(
    ordered.map((search) => search.id),
  );
  render();
  showMessage("page-message", "表示順を保存しました。", "success");
}

async function runAction(action, id) {
  if (state.busy) {
    return;
  }
  state.busy = true;
  try {
    if (action === "rename") await renameSearch(id);
    if (action === "delete") await deleteSearch(id);
    if (action === "up") await moveSearch(id, -1);
    if (action === "down") await moveSearch(id, 1);
  } finally {
    state.busy = false;
  }
}

function bindEvents() {
  byId("saved-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) {
      return;
    }
    state.busy = true;
    void createSearch()
      .catch((error) => showMessage(
        "page-message",
        error?.message || "検索条件を保存できませんでした。",
        "error",
      ))
      .finally(() => {
        state.busy = false;
      });
  });
  byId("saved-search-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action][data-search-id]");
    if (!button) {
      return;
    }
    void runAction(button.dataset.action, button.dataset.searchId).catch((error) => {
      showMessage(
        "page-message",
        error?.message || "保存済み検索を更新できませんでした。",
        "error",
      );
    });
  });
}

async function initialize() {
  bindEvents();
  await reload();
}

initializeWhenReady(initialize);

export { applicationUrl, describeCriteria, readCriteria };
