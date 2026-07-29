const CONTENT_RULES = Object.freeze([
  {
    type: "Flask",
    fileNames: ["requirements.txt", "pyproject.toml", "pipfile"],
    pattern: /(?:^|[\s"'=])flask(?:$|[\s"'<>~=])/iu,
    evidence: "依存関係ファイルにFlaskの記述があります",
  },
  {
    type: "React",
    fileNames: ["package.json"],
    pattern: /["']react["']\s*:/iu,
    evidence: "package.jsonにReactの依存関係があります",
  },
  {
    type: "Vue",
    fileNames: ["package.json"],
    pattern: /["']vue["']\s*:/iu,
    evidence: "package.jsonにVueの依存関係があります",
  },
  {
    type: "Next.js",
    fileNames: ["package.json"],
    pattern: /["']next["']\s*:/iu,
    evidence: "package.jsonにNext.jsの依存関係があります",
  },
]);

// This function only inspects text passed by an explicit user action. It never
// opens File objects and never performs network requests.
export function inspectManifestContent(fileName, content) {
  const normalizedName = String(fileName || "").toLowerCase();
  const text = String(content || "").slice(0, 2 * 1024 * 1024);
  return CONTENT_RULES
    .filter((rule) => rule.fileNames.includes(normalizedName) && rule.pattern.test(text))
    .map((rule) => ({
      type: rule.type,
      confidence: "high",
      score: 100,
      evidence: [rule.evidence],
      contentInspected: true,
    }));
}

export function mergeProjectDetections(metadataResults = [], contentResults = []) {
  const merged = new Map();
  [...metadataResults, ...contentResults].forEach((result) => {
    const existing = merged.get(result.type);
    if (!existing) {
      merged.set(result.type, {
        ...result,
        evidence: [...(result.evidence || [])],
      });
      return;
    }
    existing.score = Math.max(Number(existing.score) || 0, Number(result.score) || 0);
    existing.confidence = existing.score >= 80 ? "high" : existing.score >= 50 ? "medium" : "low";
    existing.contentInspected = Boolean(existing.contentInspected || result.contentInspected);
    existing.evidence = [...new Set([
      ...(existing.evidence || []),
      ...(result.evidence || []),
    ])];
  });
  return [...merged.values()].sort((left, right) => right.score - left.score);
}
