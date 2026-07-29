import {
  Storage,
  byId,
  copyText,
  createElement,
  ensureAnalysis,
  forEachCurrentFile,
  formatNumber,
  initializeWhenReady,
  showMessage,
} from "./page-utils.js";

const MAX_EXISTING_FILE_SIZE = 1024 * 1024;

const DIRECTORY_RULES = Object.freeze({
  node_modules: Object.freeze(["node_modules/", "Node.js依存パッケージは再取得できます。"]),
  ".pnpm-store": Object.freeze([".pnpm-store/", "pnpmのローカルキャッシュです。"]),
  ".npm": Object.freeze([".npm/", "npmのローカルキャッシュです。"]),
  ".venv": Object.freeze([".venv/", "Python仮想環境は再作成できます。"]),
  venv: Object.freeze(["venv/", "Python仮想環境は再作成できます。"]),
  __pycache__: Object.freeze(["__pycache__/", "Pythonのバイトコードキャッシュです。"]),
  ".pytest_cache": Object.freeze([".pytest_cache/", "pytestの実行キャッシュです。"]),
  ".mypy_cache": Object.freeze([".mypy_cache/", "mypyの解析キャッシュです。"]),
  ".ruff_cache": Object.freeze([".ruff_cache/", "Ruffの解析キャッシュです。"]),
  ".idea": Object.freeze([".idea/", "IDE固有の作業設定です。"]),
  ".vscode": Object.freeze([".vscode/", "エディター固有の作業設定候補です。"]),
  dist: Object.freeze(["dist/", "生成済み配布物は通常再生成できます。"]),
  build: Object.freeze(["build/", "ビルド生成物は通常再生成できます。"]),
  coverage: Object.freeze(["coverage/", "テストカバレッジ生成物です。"]),
  ".next": Object.freeze([".next/", "Next.jsのビルド生成物です。"]),
  ".nuxt": Object.freeze([".nuxt/", "Nuxtのビルド生成物です。"]),
  target: Object.freeze(["target/", "ビルド生成物を格納する一般的なフォルダです。"]),
  bin: Object.freeze(["bin/", "コンパイル済み出力の可能性があります。"]),
  obj: Object.freeze(["obj/", "コンパイル中間出力の可能性があります。"]),
});

const TEMPLATE_RULES = Object.freeze({
  general: Object.freeze([
    Object.freeze([".DS_Store", "macOSが生成する表示設定です。"]),
    Object.freeze(["Thumbs.db", "Windowsが生成するサムネイルキャッシュです。"]),
    Object.freeze(["*.log", "実行時に生成されるログです。"]),
    Object.freeze(["*.tmp", "一時ファイルです。"]),
    Object.freeze(["*.swp", "エディターの一時ファイルです。"]),
  ]),
  python: Object.freeze([
    Object.freeze(["__pycache__/", "Pythonのバイトコードキャッシュです。"]),
    Object.freeze(["*.py[cod]", "Pythonのコンパイル済みファイルです。"]),
    Object.freeze([".venv/", "Python仮想環境は再作成できます。"]),
    Object.freeze(["venv/", "Python仮想環境は再作成できます。"]),
    Object.freeze([".pytest_cache/", "pytestの実行キャッシュです。"]),
    Object.freeze([".mypy_cache/", "mypyの解析キャッシュです。"]),
    Object.freeze([".ruff_cache/", "Ruffの解析キャッシュです。"]),
    Object.freeze(["dist/", "Pythonパッケージの配布生成物です。"]),
    Object.freeze(["build/", "Pythonパッケージのビルド生成物です。"]),
    Object.freeze(["*.egg-info/", "Pythonパッケージの生成メタデータです。"]),
  ]),
  node: Object.freeze([
    Object.freeze(["node_modules/", "Node.js依存パッケージは再取得できます。"]),
    Object.freeze(["dist/", "フロントエンドのビルド生成物です。"]),
    Object.freeze(["coverage/", "テストカバレッジ生成物です。"]),
    Object.freeze([".next/", "Next.jsのビルド生成物です。"]),
    Object.freeze([".nuxt/", "Nuxtのビルド生成物です。"]),
    Object.freeze([".vite/", "Viteのキャッシュです。"]),
    Object.freeze(["npm-debug.log*", "npmのデバッグログです。"]),
    Object.freeze(["yarn-debug.log*", "Yarnのデバッグログです。"]),
    Object.freeze(["pnpm-debug.log*", "pnpmのデバッグログです。"]),
  ]),
  java: Object.freeze([
    Object.freeze(["target/", "Mavenのビルド生成物です。"]),
    Object.freeze(["build/", "Gradleのビルド生成物です。"]),
    Object.freeze([".gradle/", "Gradleのローカルキャッシュです。"]),
    Object.freeze(["*.class", "Javaのコンパイル済みクラスです。"]),
  ]),
  rust: Object.freeze([
    Object.freeze(["target/", "Cargoのビルド生成物です。"]),
    Object.freeze(["**/*.rs.bk", "rustfmtが作成するバックアップ候補です。"]),
  ]),
  go: Object.freeze([
    Object.freeze(["bin/", "Goのコンパイル済みバイナリ出力候補です。"]),
    Object.freeze(["*.test", "Goテストの生成バイナリです。"]),
    Object.freeze(["coverage.out", "Goのカバレッジ生成物です。"]),
  ]),
});

const PROJECT_TEMPLATE_MAP = Object.freeze({
  Python: "python",
  Flask: "python",
  Django: "python",
  "Node.js": "node",
  React: "node",
  Vue: "node",
  "Next.js": "node",
  Vite: "node",
  Java: "java",
  Maven: "java",
  Gradle: "java",
  Rust: "rust",
  Go: "go",
});

const state = {
  detected: new Map(),
  projectTypes: [],
  candidates: new Map(),
  selected: new Set(),
  existingLines: [],
  existingRules: new Set(),
  initialized: false,
};

function addSuggestion(target, pattern, reason) {
  const normalizedPattern = String(pattern || "").trim();
  if (!normalizedPattern || normalizedPattern.includes("\n")) {
    return;
  }
  const current = target.get(normalizedPattern) || {
    pattern: normalizedPattern,
    reasons: new Set(),
  };
  current.reasons.add(String(reason || "解析結果から検出しました。"));
  target.set(normalizedPattern, current);
}

function observeFile(file) {
  const path = String(file.relativePath || file.path || file.name || "");
  const lowerPath = path.replaceAll("\\", "/").toLowerCase();
  const name = String(file.name || lowerPath.split("/").pop() || "").toLowerCase();
  const segments = lowerPath.split("/").filter(Boolean);
  segments.forEach((segment) => {
    const rule = DIRECTORY_RULES[segment];
    if (rule) {
      addSuggestion(state.detected, rule[0], rule[1]);
    }
  });
  if (name === ".ds_store") {
    addSuggestion(state.detected, ".DS_Store", "macOSが生成する表示設定です。");
  }
  if (name === "thumbs.db") {
    addSuggestion(state.detected, "Thumbs.db", "Windowsのサムネイルキャッシュです。");
  }
  if (name === ".env" || /^\.env\..+/u.test(name)) {
    addSuggestion(state.detected, ".env", "環境変数や秘密情報を含む可能性があります。");
    addSuggestion(state.detected, ".env.local", "ローカル環境固有の秘密情報を含む可能性があります。");
    addSuggestion(state.detected, ".env.*.local", "環境固有の秘密情報を含む可能性があります。");
  }
  if (name.endsWith(".log")) {
    addSuggestion(state.detected, "*.log", "実行時に生成されるログです。");
  }
  if (/\.(tmp|temp|swp)$/u.test(name)) {
    addSuggestion(state.detected, "*.tmp", "一時ファイル候補が検出されました。");
    addSuggestion(state.detected, "*.swp", "エディターの一時ファイル候補です。");
  }
  if (/\.(bak|backup|old)$/u.test(name)) {
    addSuggestion(state.detected, "*.bak", "バックアップファイル候補です。");
  }
  if (/\.(pyc|pyo)$/u.test(name)) {
    addSuggestion(state.detected, "*.py[cod]", "Pythonのコンパイル済みファイルです。");
  }
  if (name.endsWith(".class")) {
    addSuggestion(state.detected, "*.class", "Javaのコンパイル済みクラスです。");
  }
}

function templateNames() {
  const names = new Set();
  state.projectTypes.forEach((type) => {
    const template = PROJECT_TEMPLATE_MAP[type];
    if (template) names.add(template);
  });
  const selectedTemplate = String(byId("gitignore-template")?.value || "");
  if (selectedTemplate) names.add(selectedTemplate);
  return names;
}

function rebuildCandidates() {
  const previousSelected = new Set(state.selected);
  const previousCandidates = new Set(state.candidates.keys());
  const candidates = new Map();
  state.detected.forEach((item) => {
    item.reasons.forEach((reason) => addSuggestion(candidates, item.pattern, reason));
  });
  templateNames().forEach((templateName) => {
    (TEMPLATE_RULES[templateName] || []).forEach(([pattern, reason]) => {
      addSuggestion(candidates, pattern, reason);
    });
  });
  state.candidates = candidates;
  state.selected = new Set(
    [...candidates.keys()].filter((pattern) => (
      !state.existingRules.has(pattern)
      && (
        !state.initialized
        || previousSelected.has(pattern)
        || !previousCandidates.has(pattern)
      )
    )),
  );
  state.initialized = true;
}

function buildPreview() {
  const existing = state.existingLines.join("\n").trimEnd();
  const additions = [...state.candidates.keys()]
    .filter((pattern) => state.selected.has(pattern) && !state.existingRules.has(pattern))
    .sort((left, right) => left.localeCompare(right));
  const sections = [];
  if (existing) {
    sections.push(existing);
  }
  if (additions.length) {
    sections.push([
      "# Folder Visualizer suggestions",
      ...additions,
    ].join("\n"));
  }
  if (!sections.length) {
    return "# Folder Visualizer suggestions\n# 選択された候補はありません。\n";
  }
  return `${sections.join("\n\n")}\n`;
}

function updatePreview() {
  const preview = byId("gitignore-preview");
  if (preview) {
    preview.value = buildPreview();
  }
}

function renderSuggestions() {
  const target = byId("gitignore-suggestions");
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  const rows = [...state.candidates.values()].sort(
    (left, right) => left.pattern.localeCompare(right.pattern),
  );
  rows.forEach((item) => {
    const alreadyExists = state.existingRules.has(item.pattern);
    const checkbox = createElement("input", {
      type: "checkbox",
      dataset: { pattern: item.pattern },
      attributes: {
        "aria-label": `${item.pattern}を出力候補に含める`,
      },
    });
    checkbox.checked = state.selected.has(item.pattern);
    checkbox.disabled = alreadyExists;
    const heading = createElement("div", { className: "stack-card-header" }, [
      createElement("code", { text: item.pattern }),
      createElement("span", {
        className: alreadyExists ? "tag" : "tag tag-warning",
        text: alreadyExists ? "既存ルール" : "候補",
      }),
    ]);
    const reason = createElement("p", {
      text: [...item.reasons].join("、"),
    });
    fragment.appendChild(createElement("label", { className: "stack-card" }, [
      checkbox,
      heading,
      reason,
    ]));
  });
  if (!rows.length) {
    fragment.appendChild(createElement("p", {
      className: "empty-copy",
      text: "現在の解析結果から候補を検出できませんでした。テンプレートを選択してください。",
    }));
  }
  target.replaceChildren(fragment);
  updatePreview();
}

async function scanMetadata() {
  showMessage("page-message", "解析結果から候補を抽出しています。", "warning");
  let processed = 0;
  await forEachCurrentFile((rows, start, total) => {
    rows.forEach(observeFile);
    processed = start + rows.length;
    if (start === 0 || processed === total || processed % 5000 === 0) {
      showMessage(
        "page-message",
        `候補を抽出中: ${formatNumber(processed)} / ${formatNumber(total)}`,
        "warning",
      );
    }
  }, { chunkSize: 2000 });
}

function normalizedExistingRules(lines) {
  return new Set(lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")));
}

async function readExistingGitignore() {
  const files = [...(byId("existing-gitignore")?.files || [])];
  if (files.length !== 1) {
    throw new Error("確認する既存.gitignoreを1件選択してください。");
  }
  const [file] = files;
  if (Number(file.size) > MAX_EXISTING_FILE_SIZE) {
    throw new Error("1 MBを超えるため読み取りませんでした。");
  }
  // This is the only existing-.gitignore read and is reached exclusively
  // through the user's explicit button click.
  const text = (await file.text()).replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  state.existingLines = text.split("\n");
  state.existingRules = normalizedExistingRules(state.existingLines);
  rebuildCandidates();
  renderSuggestions();
  showMessage(
    "page-message",
    `既存ルール${formatNumber(state.existingRules.size)}件と照合しました。内容はサーバへ送信していません。`,
    "success",
  );
}

async function copyPreview() {
  await copyText(buildPreview());
  showMessage("page-message", ".gitignore候補をコピーしました。", "success");
}

function downloadPreview() {
  const blob = new Blob([buildPreview()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = ".gitignore";
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showMessage(
    "page-message",
    ".gitignore候補をダウンロードしました。元ファイルは変更していません。",
    "success",
  );
}

function bindEvents() {
  byId("gitignore-template")?.addEventListener("change", () => {
    rebuildCandidates();
    renderSuggestions();
  });
  byId("gitignore-suggestions")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-pattern]");
    if (!checkbox) {
      return;
    }
    if (checkbox.checked) {
      state.selected.add(checkbox.dataset.pattern);
    } else {
      state.selected.delete(checkbox.dataset.pattern);
    }
    updatePreview();
  });
  byId("read-existing-gitignore")?.addEventListener("click", () => {
    void readExistingGitignore().catch((error) => {
      showMessage(
        "page-message",
        error?.message || "既存.gitignoreを確認できませんでした。",
        "error",
      );
    });
  });
  byId("copy-gitignore")?.addEventListener("click", () => {
    void copyPreview().catch((error) => {
      showMessage(
        "page-message",
        error?.message || "クリップボードへコピーできませんでした。",
        "error",
      );
    });
  });
  byId("download-gitignore")?.addEventListener("click", downloadPreview);
}

async function initialize() {
  const status = await ensureAnalysis();
  if (!status.available) {
    return;
  }
  state.projectTypes = (await Storage.getProjectDetection())
    .filter((item) => Number(item.score) >= 50)
    .map((item) => String(item.type || ""));
  bindEvents();
  await scanMetadata();
  rebuildCandidates();
  renderSuggestions();
  showMessage(
    "page-message",
    `${formatNumber(state.candidates.size)}件の候補をブラウザ内で生成しました。`,
    "success",
  );
}

initializeWhenReady(initialize);

export {
  TEMPLATE_RULES,
  addSuggestion,
  buildPreview,
  normalizedExistingRules,
};
