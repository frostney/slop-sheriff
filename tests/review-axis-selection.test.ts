import { describe, expect, test } from "bun:test";
import { selectReviewAxes } from "../src/review/axis-selection";
import { hasCompletePatch, type PatchFile } from "../src/review/effective-patch";

function change(path: string, before: string, after: string): PatchFile {
  const oldLines = before ? before.split("\n") : [];
  const newLines = after ? after.split("\n") : [];
  const file: PatchFile = {
    path, status: "modified", blobSha: "a".repeat(40),
    additions: newLines.length, deletions: oldLines.length,
    patch: [`@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n"),
  };
  expect(hasCompletePatch(file)).toBeTrue();
  return file;
}
function selected(...files: PatchFile[]) {
  return selectReviewAxes(files, []).filter((item) => item.selected).map((item) => item.axis);
}

describe("specialists selected from changed review needs", () => {
  test("ordinary behavior gets core review and independent real-interface checks", () => {
    expect(selected(change("src/total.ts", "return count;", "return count + 1;")))
      .toEqual(["engineering-quality", "test-against-spec"]);
  });
  test("comments and docs do not dispatch unrelated runtime and test-health work", () => {
    expect(selected(change("src/total.ts", "// Count the values", "// Count only active values")))
      .toEqual(["engineering-quality", "writing-quality"]);
    expect(selected(change("README.md", "Welcome to the project.", "Read the setup guide.")))
      .toEqual(["engineering-quality", "writing-quality"]);
  });
  test("tests get independent brittleness review without duplicating implementation verification", () => {
    expect(selected(change("tests/total.test.ts", "expect(total()).toBe(1);", "expect(total()).toBe(2);")))
      .toEqual(["engineering-quality", "test-health"]);
  });
  test("lock and binary changes retain core ownership without irrelevant specialists", () => {
    expect(selected(change("bun.lock", "old", "new"), { path: "logo.png", status: "modified", blobSha: "a", patch: null }))
      .toEqual(["engineering-quality"]);
  });
  test("public contracts and explicit requirements widen claim verification", () => {
    expect(selected(change("src/api.ts", "", "export function total() { return 2; }")))
      .toEqual(["claim-and-specification", "engineering-quality", "test-against-spec"]);
    expect(selected(change("docs/requirements.md", "", "The CLI must reject missing input.")))
      .toEqual(["claim-and-specification", "engineering-quality", "test-against-spec", "writing-quality"]);
  });
  test("dependency changes trigger existing-capability comparison", () => {
    expect(selected(change("package.json", '"dependencies": {}', '"dependencies": { "left-pad": "1.3.0" }')))
      .toEqual(["deduplication", "engineering-quality"]);
  });
  test("consequential state and security changes get additional contract and test sensitivity review", () => {
    expect(selected(change("src/authorization.ts", "return true;", "return user.allowed;")))
      .toEqual(["claim-and-specification", "engineering-quality", "test-against-spec", "test-health"]);
  });
  test("missing, truncated and unfamiliar patches widen conservatively", () => {
    const file = change("src/main.ts", "return 1;", "return 2;");
    for (const candidate of [{ ...file, patch: null }, { ...file, additions: 2 }, { ...file, path: "custom-format" }]) {
      expect(selected(candidate)).toEqual(["deduplication", "claim-and-specification", "engineering-quality", "test-against-spec", "writing-quality", "test-health"]);
    }
  });
  test("public roots still select discoverability and all decisions retain their reason", () => {
    const decisions = selectReviewAxes([change("site/index.html", "<p>Old title</p>", "<p>New title</p>")], ["site"]);
    expect(decisions.find((item) => item.axis === "discoverability")).toMatchObject({ selected: true, paths: ["site/index.html"] });
    expect(decisions).toHaveLength(7);
    expect(decisions.every((item) => item.reason.length > 0)).toBeTrue();
  });
});
