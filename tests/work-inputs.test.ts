import { expect, test } from "bun:test";
import { reviewWorkInputDigest, snapshotReviewWorkInputs } from "../src/review/work-inputs";
import { workHash, type ReviewWorkUnit } from "../src/review/work-plan";

const unit: ReviewWorkUnit = { id: workHash("payments"), axis: "engineering-quality", component: "src/payments",
  paths: ["src/payments/charge.ts"], requirementIds: [], policyDigest: workHash("policy") };
const original = new Map([["src/payments/charge.ts", "charge-v1"], ["src/payments/types.ts", "types-v1"], ["docs/install.md", "docs-v1"], ["package.json", "deps-v1"]]);
const snapshot = (head = original, base = original) => snapshotReviewWorkInputs({ unit, base, head, requirements: [], claim: "Charge once" });

test("an unrelated docs fix preserves technical work without a published baseline", () => {
  const next = new Map(original); next.set("docs/install.md", "docs-v2");
  expect(reviewWorkInputDigest(snapshot(next))).toBe(reviewWorkInputDigest(snapshot()));
});

test("supporting code, negative component scope, dependencies and base context invalidate work", () => {
  for (const [path,value] of [["src/payments/types.ts","types-v2"], ["src/payments/duplicate.ts","new"], ["package.json","deps-v2"]]) {
    const next = new Map(original); next.set(path ?? "", value ?? "");
    expect(reviewWorkInputDigest(snapshot(next))).not.toBe(reviewWorkInputDigest(snapshot()));
  }
  const base = new Map(original); base.set("src/payments/types.ts", "new-base-contract");
  expect(reviewWorkInputDigest(snapshot(original, base))).not.toBe(reviewWorkInputDigest(snapshot()));
});

test("tree enumeration order and commit labels are not semantic changes", () => {
  expect(reviewWorkInputDigest(snapshot(new Map([...original].reverse())))).toBe(reviewWorkInputDigest(snapshot()));
});
