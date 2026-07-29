import {
  Storage,
  byId,
  createElement,
  ensureAnalysis,
  formatNumber,
  initializeWhenReady,
  setText,
  showMessage,
} from "./page-utils.js";

const MAX_MANIFEST_SIZE = 2 * 1024 * 1024;
const MAX_MANIFESTS = 20;

const CONFIDENCE_LABELS = Object.freeze({
  high: "高",
  medium: "中",
  low: "低",
});

const DEPENDENCY_TECHNOLOGIES = Object.freeze({
  react: "React",
  "react-dom": "React",
  vue: "Vue",
  next: "Next.js",
  vite: "Vite",
  express: "Express",
  typescript: "TypeScript",
  svelte: "Svelte",
  nuxt: "Nuxt",
  angular: "Angular",
  flask: "Flask",
  django: "Django",
  fastapi: "FastAPI",
  pytest: "pytest",
  spring: "Spring",
  "spring-boot": "Spring Boot",
});

const PYTHON_TECHNOLOGIES = Object.freeze({
  flask: "Flask",
  django: "Django",
  fastapi: "FastAPI",
  pytest: "pytest",
});

function confidenceFromScore(score) {
  const value = Number(score) || 0;
  return value >= 80 ? "high" : value >= 50 ? "medium" : "low";
}

function createEvidenceList(evidence = []) {
  const list = createElement("ul");
  evidence.forEach((reason) => {
    list.appendChild(createElement("li", { text: String(reason) }));
  });
  return list;
}

function renderStoredDetection(detection) {
  const score = Math.max(0, Math.min(100, Math.round(Number(detection.score) || 0)));
  const confidence = detection.confidence || confidenceFromScore(score);
  return createElement("article", { className: "feature-card" }, [
    createElement("span", {
      className: confidence === "low" ? "tag tag-warning" : "tag",
      text: `信頼度 ${CONFIDENCE_LABELS[confidence] || confidence}・${score}%`,
    }),
    createElement("h3", { text: String(detection.type || "不明") }),
    createEvidenceList(Array.isArray(detection.evidence) ? detection.evidence : []),
  ]);
}

function renderStoredDetections(rows) {
  const target = byId("project-results");
  if (!target) {
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.appendChild(renderStoredDetection(row)));
  if (!rows.length) {
    fragment.appendChild(createElement("p", {
      className: "empty-copy",
      text: "開発プロジェクトを示す明確なファイル構成は検出されませんでした。",
    }));
  }
  target.replaceChildren(fragment);
  setText("project-count", `${formatNumber(rows.length)}件の技術候補`);
}

function addTechnology(map, type, score, reason) {
  const current = map.get(type) || {
    type,
    score: 0,
    evidence: new Set(),
  };
  current.score = Math.max(current.score, score);
  current.evidence.add(reason);
  map.set(type, current);
}

function normalizeTechnologies(map) {
  return [...map.values()]
    .map((item) => {
      const score = Math.min(
        100,
        item.score + Math.max(0, item.evidence.size - 1) * 5,
      );
      return {
        type: item.type,
        score,
        confidence: confidenceFromScore(score),
        evidence: [...item.evidence],
      };
    })
    .sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
}

function inspectPackageJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("package.jsonをJSONとして解析できませんでした。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.jsonのルートはJSONオブジェクトである必要があります。");
  }
  const dependencyNames = new Set();
  ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .forEach((key) => {
      const group = parsed[key];
      if (group && typeof group === "object" && !Array.isArray(group)) {
        Object.keys(group).forEach((name) => dependencyNames.add(name.toLowerCase()));
      }
    });
  const technologies = new Map();
  addTechnology(technologies, "Node.js", 90, "package.jsonを正常に解析");
  dependencyNames.forEach((dependency) => {
    const technology = DEPENDENCY_TECHNOLOGIES[dependency];
    if (technology) {
      addTechnology(
        technologies,
        technology,
        92,
        `依存パッケージ「${dependency}」を検出`,
      );
    }
  });
  const details = [
    `依存パッケージ: ${formatNumber(dependencyNames.size)}件`,
    `スクリプト: ${formatNumber(
      parsed.scripts && typeof parsed.scripts === "object"
        ? Object.keys(parsed.scripts).length
        : 0,
    )}件`,
  ];
  if (typeof parsed.name === "string" && parsed.name.trim()) {
    details.unshift(`パッケージ名: ${parsed.name.trim().slice(0, 200)}`);
  }
  return { technologies: normalizeTechnologies(technologies), details };
}

function packageNamesFromLines(text) {
  const names = new Set();
  text.split(/\r?\n/u).forEach((line) => {
    const normalized = line.trim();
    if (!normalized || normalized.startsWith("#") || normalized.startsWith("-")) {
      return;
    }
    const name = normalized.split(/[<>=!~;[\]\s]/u, 1)[0].trim().toLowerCase();
    if (/^[a-z0-9_.-]+$/u.test(name)) {
      names.add(name);
    }
  });
  return names;
}

function dependencyMentioned(text, dependency) {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:^|[^a-z0-9_.-])${escaped}(?:$|[^a-z0-9_.-])`,
    "iu",
  ).test(text);
}

function inspectPythonManifest(text, fileName) {
  const lower = text.toLowerCase();
  const packages = packageNamesFromLines(text);
  const technologies = new Map();
  addTechnology(technologies, "Python", 90, `${fileName}を正常に解析`);
  for (const [dependency, technology] of Object.entries(PYTHON_TECHNOLOGIES)) {
    if (packages.has(dependency) || dependencyMentioned(lower, dependency)) {
      addTechnology(
        technologies,
        technology,
        90,
        `依存関係「${dependency}」を検出`,
      );
    }
  }
  return {
    technologies: normalizeTechnologies(technologies),
    details: packages.size
      ? [`依存パッケージ候補: ${formatNumber(packages.size)}件`]
      : ["依存パッケージ数は形式上正確に取得できませんでした。"],
  };
}

function inspectBuildManifest(text, fileName) {
  const lower = text.toLowerCase();
  const technologies = new Map();
  const details = [];
  const addIf = (condition, type, score, reason) => {
    if (condition) addTechnology(technologies, type, score, reason);
  };
  if (fileName === "pom.xml") {
    addTechnology(technologies, "Maven", 95, "pom.xmlを正常に解析");
    addIf(lower.includes("spring"), "Spring", 85, "Spring関連のartifactを検出");
    const dependencies = text.match(/<dependency(?:\s|>)/giu) || [];
    details.push(`dependency要素: ${formatNumber(dependencies.length)}件`);
  } else if (fileName === "build.gradle" || fileName === "build.gradle.kts") {
    addTechnology(technologies, "Gradle", 95, `${fileName}を正常に解析`);
    addIf(lower.includes("org.springframework"), "Spring", 85, "Springプラグインを検出");
    addIf(lower.includes("com.android."), "Android", 85, "Androidプラグインを検出");
  } else if (fileName === "cargo.toml") {
    addTechnology(technologies, "Rust", 95, "Cargo.tomlを正常に解析");
    const dependencies = text.match(/^\s*[a-zA-Z0-9_-]+\s*=/gmu) || [];
    details.push(`設定・依存項目候補: ${formatNumber(dependencies.length)}件`);
  } else if (fileName === "go.mod") {
    addTechnology(technologies, "Go", 95, "go.modを正常に解析");
    const moduleMatch = text.match(/^\s*module\s+([^\s]+)\s*$/mu);
    if (moduleMatch) details.push(`モジュール: ${moduleMatch[1].slice(0, 200)}`);
    const requirements = text.match(/^\s*[a-z0-9._~/-]+\s+v\d/gimu) || [];
    details.push(`依存モジュール候補: ${formatNumber(requirements.length)}件`);
  }
  return { technologies: normalizeTechnologies(technologies), details };
}

function inspectManifestText(fileName, text) {
  const name = String(fileName || "").split(/[\\/]/u).pop().toLowerCase();
  if (name === "package.json") {
    return inspectPackageJson(text);
  }
  if (["requirements.txt", "pyproject.toml", "pipfile", "poetry.lock"].includes(name)) {
    return inspectPythonManifest(text, name);
  }
  if ([
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "cargo.toml",
    "go.mod",
  ].includes(name)) {
    return inspectBuildManifest(text, name);
  }
  throw new Error("対応しているマニフェストではありません。");
}

async function inspectSelectedFile(file) {
  if (Number(file.size) > MAX_MANIFEST_SIZE) {
    throw new Error("2 MBを超えるため読み取りませんでした。");
  }
  // File.text() is deliberately called only from the explicit inspection
  // button handler. Its contents never leave this browser.
  const text = await file.text();
  return inspectManifestText(file.name, text);
}

function renderManifestResult(file, result = null, error = null) {
  const children = [
    createElement("div", { className: "stack-card-header" }, [
      createElement("h3", { text: file.name }),
      createElement("span", {
        className: error ? "tag tag-warning" : "tag",
        text: error ? "確認できませんでした" : "ブラウザ内で確認済み",
      }),
    ]),
  ];
  if (error) {
    children.push(createElement("p", { text: error.message }));
    return createElement("article", { className: "stack-card" }, children);
  }
  const details = createElement("div", { className: "stack-card-meta" });
  (result.details || []).forEach((detail) => {
    details.appendChild(createElement("span", { text: detail }));
  });
  children.push(details);
  if (result.technologies.length) {
    const list = createElement("ul");
    result.technologies.forEach((technology) => {
      list.appendChild(createElement("li", {
        text: `${technology.type}（${technology.score}%）: ${technology.evidence.join("、")}`,
      }));
    });
    children.push(list);
  } else {
    children.push(createElement("p", {
      text: "追加の技術スタックは推定できませんでした。",
    }));
  }
  return createElement("article", { className: "stack-card" }, children);
}

async function inspectSelectedManifests() {
  const files = [...(byId("manifest-input")?.files || [])];
  if (!files.length) {
    throw new Error("確認するマニフェストを選択してください。");
  }
  if (files.length > MAX_MANIFESTS) {
    throw new Error(`一度に確認できるファイルは${MAX_MANIFESTS}件までです。`);
  }
  const button = byId("inspect-manifests");
  const target = byId("manifest-results");
  button.disabled = true;
  target.replaceChildren();
  showMessage(
    "page-message",
    "選択したマニフェストをブラウザ内で確認しています。",
    "warning",
  );
  try {
    for (const file of files) {
      try {
        const result = await inspectSelectedFile(file);
        target.appendChild(renderManifestResult(file, result));
      } catch (error) {
        target.appendChild(renderManifestResult(
          file,
          null,
          error instanceof Error ? error : new Error("内容を確認できませんでした。"),
        ));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    showMessage(
      "page-message",
      "詳細確認が完了しました。読み取った内容はサーバへ送信していません。",
      "success",
    );
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  const status = await ensureAnalysis();
  if (!status.available) {
    return;
  }
  renderStoredDetections(await Storage.getProjectDetection());
  byId("inspect-manifests")?.addEventListener("click", () => {
    void inspectSelectedManifests().catch((error) => {
      showMessage(
        "page-message",
        error?.message || "マニフェストを確認できませんでした。",
        "error",
      );
    });
  });
}

initializeWhenReady(initialize);

export {
  confidenceFromScore,
  inspectManifestText,
  inspectPackageJson,
  packageNamesFromLines,
};
