import { reviewWorkInputSchema } from "../../src/review/work-execution";

export function completeReviewWorkInput() {
  return reviewWorkInputSchema.parse({ action: { operation: "complete", reviewedEntries: [0], report: {
    axis: "engineering-quality",
    scope: { claim: "Reject invalid input", dirtyState: "Frozen head", inspectedSupportingContext: ["src/index.ts"] },
    coverage: { staticOnly: ["Source inspection"], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [], candidates: [{ title: "Reject invalid input", location: { path: "src/index.ts", line: 1, symbol: "accept" },
      evidence: ["The public accept function returns an invalid value without validation."],
      impact: "Invalid values reach callers", impactSummary: "Invalid values reach callers", remedy: "Validate the public input before returning it",
      staticOnly: true, churn: null, uncertainty: [], evidenceRefs: [] }],
    verifiedClaims: [], limitations: [], specialistChecks: null, requirementChecks: null,
  } } });
}
