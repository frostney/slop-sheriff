import { discoverabilityApplies } from "./discoverability";
import { hasCompletePatch, type PatchFile } from "./effective-patch";
import { reviewAxes, type ReviewAxis } from "./axes";

const binary = /\.(?:png|jpe?g|gif|webp|ico|avif|woff2?|ttf|mp[34]|zip|gz|pdf|wasm)$/i;
const lock = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/i;
const prose = /\.(?:mdx?|rst|adoc|txt)$/i;
const source = /\.(?:[cm]?[jt]sx?|vue|svelte|py|rs|go|java|kt|kts|cs|fs|cpp|cc|c|h|hpp|pas|pp|p|inc|rb|php|swift|sh|bash|sql|html?|css|scss)$/i;
const configuration = /\.(?:json|ya?ml|toml|ini|xml|config)$/i;
const testPath = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|__fixtures__|__mocks__|e2e|playwright|cypress)(?:\/|$)|(?:[._-](?:test|spec|snap)\.)|(?:^|\/)(?:vitest|jest|playwright|cypress)\.config\./i;
const manifest = /(?:^|\/)(?:package\.json|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|Gemfile|composer\.json|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/i;
const requirement = /\b(?:must|shall|required|acceptance criteria|expected (?:behavior|behaviour|result)|guarantees?|returns?|rejects?)\b/i;
const risk = /\b(?:authorization|authentication|permission|security|tenant|migration|transaction|rollback|parser|sanitize|signature|cryptograph|concurren|idempoten)\w*/i;
const publicContract = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const)|pub(?:\([^)]*\))?\s+(?:fn|struct|enum|trait)|public\s+|interface\b)/m;

export interface ReviewAxisDecision {
  readonly axis: ReviewAxis;
  readonly selected: boolean;
  readonly reason: string;
  readonly paths: string[];
}

/** Central triage retains a broad core review; it never uses diff-size budgets. */
export function selectReviewAxes(files: readonly PatchFile[], publicRoots: readonly string[]): ReviewAxisDecision[] {
  const reasons = new Map<ReviewAxis, Map<string, string>>();
  const select = (axis: ReviewAxis, path: string, reason: string) => {
    const matches = reasons.get(axis) ?? new Map<string, string>();
    matches.set(path, reason);
    reasons.set(axis, matches);
  };
  for (const file of files) {
    const path = file.path;
    select("engineering-quality", path, "Core correctness, claim alignment, reuse and test-value review.");
    if (binary.test(path) || lock.test(path)) continue;
    const tests = testPath.test(path);
    const docs = prose.test(path) && !manifest.test(path);
    const known = source.test(path) || docs || configuration.test(path) || manifest.test(path) || /(?:^|\/)(?:Dockerfile|Makefile|\.gitignore|\.gitattributes)$/.test(path);
    if (!known || !hasCompletePatch(file)) {
      for (const axis of reviewAxes) {
        if (axis !== "discoverability") select(axis, path, "Unavailable, incomplete or unfamiliar patch requires conservative specialist review.");
      }
      continue;
    }
    const changed = file.patch!.split("\n").filter((line) => /^[+-]/.test(line)).map((line) => line.slice(1));
    const added = file.patch!.split("\n").filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n");
    const text = changed.join("\n");
    const code = changed.filter((line) => line.trim() && !/^\s*(?:\/\/|\/\*|\*|\*\/|#|<!--|-->)/.test(line)).join("\n");
    if (docs || changed.some((line) => /(?:\/\/|\/\*|^\s*\*|^\s*#|<!--)/.test(line) && /[a-z]+\s+[a-z]+/i.test(line)) || /["'`][^"'`\n]*[a-z]+\s+[a-z]+[^"'`\n]*["'`]/i.test(text) || />[^<>\n]*[a-z]+\s+[a-z]+[^<>\n]*</i.test(text)) {
      select("writing-quality", path, "Changed authored prose, user-facing text or substantive comments.");
    }
    if (tests || /(?:^|\/)\.github\/workflows\//.test(path) && /\b(?:test|check|coverage|eval)\b/.test(text)) {
      select("test-health", path, "Changed tests, fixtures or test execution configuration need sensitivity and brittleness review.");
    }
    if (docs && requirement.test(text) || !tests && publicContract.test(code)) {
      select("claim-and-specification", path, "Changed explicit requirements or public contracts need a focused claim review.");
    }
    if (!tests && !manifest.test(path) && (source.test(path) && code.trim() || docs && requirement.test(text))) {
      select("test-against-spec", path, "Changed delivered behavior or an explicit behavioral requirement needs real-interface verification.");
    }
    if (!tests && (manifest.test(path) && added.trim() || /(?:^|\/)(?:utils?|helpers?|common|shared|adapters?)(?:\/|[._-])/.test(path) && code.trim())) {
      select("deduplication", path, "New dependency or shared abstraction needs comparison with existing capabilities.");
    }
    if (!tests && code.trim() && risk.test(`${path}\n${code}`)) {
      select("claim-and-specification", path, "Security, persistence, parsing or concurrency behavior needs focused contract review.");
      select("test-health", path, "Consequential failure behavior needs independent regression sensitivity checks.");
    }
  }
  if (discoverabilityApplies(files.map((file) => file.path), publicRoots)) {
    for (const file of files.filter((file) => discoverabilityApplies([file.path], publicRoots))) {
      select("discoverability", file.path, "Changed public web surface needs discoverability review.");
    }
  }
  if (!reasons.has("engineering-quality")) reasons.set("engineering-quality", new Map());
  return reviewAxes.map((axis) => ({
    axis, selected: reasons.has(axis),
    reason: reasons.has(axis)
      ? [...new Set(reasons.get(axis)!.values())].join(" ") || "Core review checks the supplied scope."
      : "No separate specialist obligation was found in the changed content; the core review retains overall correctness, claims and reuse.",
    paths: [...(reasons.get(axis)?.keys() ?? [])],
  }));
}
