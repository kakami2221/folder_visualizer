const app = window.FolderVisualizer = window.FolderVisualizer || {};

function setGlobalError(message = "") {
  const target = document.getElementById("global-error");
  if (!target) {
    return;
  }
  target.textContent = message;
  target.classList.toggle("hidden", !message);
}

function setStatusBadge(status) {
  const badge = document.getElementById("analysis-status-badge");
  if (!badge) {
    return;
  }
  const available = Boolean(status?.available || status?.usable);
  badge.textContent = available ? "解析結果あり" : "解析結果なし";
  badge.classList.toggle("status-badge-ready", available);
  badge.classList.toggle("status-badge-empty", !available);
}

function setAnalysisNavigation(available) {
  document.querySelectorAll("[data-analysis-link]").forEach((link) => {
    link.classList.toggle("is-disabled", !available);
    link.setAttribute("aria-disabled", String(!available));
    if (available) {
      link.removeAttribute("tabindex");
    } else {
      link.setAttribute("tabindex", "-1");
    }
  });
}

async function refreshStatus() {
  try {
    const storage = app.Storage || app.storage;
    const status = storage?.getAnalysisStatus
      ? await storage.getAnalysisStatus()
      : { available: false, reason: "unavailable" };
    setStatusBadge(status);
    setAnalysisNavigation(Boolean(status?.available || status?.usable));
    return status;
  } catch (error) {
    console.error("解析結果の状態を確認できませんでした。", error);
    setStatusBadge({ available: false });
    setAnalysisNavigation(false);
    return { available: false, reason: "indexeddb-unavailable" };
  }
}

function initializeMenu() {
  const button = document.getElementById("mobile-menu-button");
  const navigation = document.getElementById("site-navigation");
  if (!button || !navigation) {
    return;
  }
  const close = () => {
    navigation.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "メニューを開く");
  };
  button.addEventListener("click", () => {
    const open = !navigation.classList.contains("is-open");
    navigation.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });
}

function initializeErrorBoundary() {
  window.addEventListener("error", (event) => {
    if (event.error) {
      console.error("画面処理でエラーが発生しました。", event.error);
      setGlobalError("画面の処理中にエラーが発生しました。ページを再読み込みしてください。");
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("非同期処理でエラーが発生しました。", event.reason);
    setGlobalError("処理を完了できませんでした。画面上の案内を確認して再試行してください。");
  });
}

function initialize() {
  initializeMenu();
  initializeErrorBoundary();
  void refreshStatus();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}

app.BasePage = Object.freeze({
  refreshStatus,
  setGlobalError,
});
