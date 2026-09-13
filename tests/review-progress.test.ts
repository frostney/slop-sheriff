import { expect, test } from "bun:test";
import { beginCurrentHeadReview } from "../src/github/review-progress";
import { encodeReviewState, type ReviewState } from "../src/github/review-state";

test("accepting a new head preserves the evidence baseline but immediately withdraws clearance", () => {
  const state: ReviewState = {
    schemaVersion: 2, app: "known-good-review", pullRequest: 43, initialFullStatus: "completed", updatedAt: "2026-09-12T00:00:00.000Z",
    baseline: { head: "a".repeat(40), patchFingerprint: "b".repeat(64), files: {}, findingsArtifactUrl: "https://github.com/acme/repo/checks/1", report: {
      schemaVersion: 2, kind: "code-review", generatedAt: "2026-09-12T00:00:00.000Z", verdict: "APPROVE",
      scope: { claim: "Change behavior", base: "c".repeat(40), head: "a".repeat(40), dirtyState: "clean" },
      coverage: { activeAxes: ["engineering-quality"], skippedAxes: [], staticOnly: [], unreached: [] },
      churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, findings: [], probes: [], verifiedClaims: [], limitations: [],
    } },
  };
  expect(encodeReviewState(state)).toContain("clear to merge");
  const next = beginCurrentHeadReview(state, "d".repeat(40));
  expect(next.baseline).toEqual(state.baseline);
  expect(next.currentHead).toBe("d".repeat(40));
  expect(encodeReviewState(next)).not.toContain("clear to merge");
  expect(encodeReviewState(next)).toContain("⏳");
  expect(encodeReviewState({ ...next, initialFullStatus: "completed" })).not.toContain("clear to merge");
  expect(encodeReviewState(beginCurrentHeadReview(state, "d".repeat(40), "failed"))).toContain("⚠️");
});
