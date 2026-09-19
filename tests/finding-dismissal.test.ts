import { expect, test } from "bun:test";
import { dismissFinding, parseFindingDismissal } from "../src/github/finding-dismissal";
import { decodeReviewState, encodeReviewState, type ReviewState } from "../src/github/review-state";

const head = "a".repeat(40);
const base = "b".repeat(40);
function state(): ReviewState {
  return {
    schemaVersion: 2, app: "known-good-review", pullRequest: 43,
    initialFullStatus: "completed", updatedAt: "2026-09-12T00:00:00.000Z",
    baseline: { head, patchFingerprint: "c".repeat(64), files: {}, findingsArtifactUrl: "https://github.com/acme/repo/checks/1", report: {
      schemaVersion: 2, kind: "code-review", generatedAt: "2026-09-12T00:00:00.000Z", verdict: "REQUEST_CHANGES",
      scope: { claim: "Add a custom installation offer", base, head, dirtyState: "clean" },
      coverage: { activeAxes: ["claim-and-specification"], skippedAxes: [], staticOnly: [], unreached: [] },
      churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [], verifiedClaims: [], limitations: [],
      actionSummary: "Add the booking URL before merging.",
      findings: [{ id: "CR-1", status: "open", severity: "IMPORTANT", category: "CLAIM", title: "Booking URL is missing",
        location: { path: "src/landing/page.ts", line: 73, symbol: null }, evidence: ["The booking action is absent."],
        impact: "Visitors cannot book a call.", remedy: "Add the booking URL.", staticOnly: true, churn: null }],
    } },
  };
}
function input() {
  return { command: { findingId: "CR-1", reason: "Booking link is explicitly deferred until the owner creates it." },
    authorized: true, actor: "maintainer", commentId: 123, headSha: head, baseSha: base, state: state() };
}

test("dismiss command needs an explicit bot command, finding identity and reason", () => {
  expect(parseFindingDismissal("@slop-sheriff dismiss CR-1 Accepted product deferral")).toEqual({ findingId: "CR-1", reason: "Accepted product deferral" });
  for (const body of ["@slop-sheriff dismiss CR-1", "> @slop-sheriff dismiss CR-1 reason", "@slop-sheriff-other dismiss CR-1 reason", "Example: @slop-sheriff dismiss CR-1 reason"]) {
    expect(parseFindingDismissal(body)).toBeNull();
  }
});

test("authorized dismissal changes outstanding recommendation without claiming a fix", () => {
  const report = dismissFinding(input());
  expect(report.verdict).toBe("APPROVE");
  expect(report.actionSummary).toBeUndefined();
  expect(report.findings[0]).toMatchObject({ status: "deferred", dismissal: { actor: "maintainer", commentId: "123", head } });
  const original = state();
  if (!original.baseline) throw new Error("Missing fixture baseline");
  const persisted = { ...original, baseline: { ...original.baseline, report } };
  expect(decodeReviewState(encodeReviewState(persisted))?.baseline?.report.findings[0]?.dismissal).toEqual(report.findings[0]?.dismissal);
  expect(dismissFinding({ ...input(), state: persisted })).toEqual(report);
});

test("unauthorized, stale, running and unknown finding dismissals cannot clear a review", () => {
  expect(() => dismissFinding({ ...input(), authorized: false })).toThrow("permission");
  expect(() => dismissFinding({ ...input(), headSha: "c".repeat(40) })).toThrow("current base and head");
  expect(() => dismissFinding({ ...input(), baseSha: "c".repeat(40) })).toThrow("current base and head");
  expect(() => dismissFinding({ ...input(), state: { ...state(), initialFullStatus: "running" } })).toThrow("completed review");
  expect(() => dismissFinding({ ...input(), command: { findingId: "CR-2", reason: "Unrelated" } })).toThrow("does not belong");
});

test("later reviews retain accepted concerns but do not dismiss changed scope or risk", async () => {
  const { preserveFindingDismissals } = await import("../src/review/finding-identity");
  const { findingsToRevalidate } = await import("../src/review/revalidation");
  const accepted = dismissFinding(input());
  expect(findingsToRevalidate(accepted.findings, new Set(["src/landing/page.ts"]))).toEqual([]);
  const next = { ...state().baseline!.report, scope: { ...accepted.scope, head: "d".repeat(40) } };
  const restored = preserveFindingDismissals(next, accepted);
  expect(restored.findings[0]?.dismissal).toEqual(accepted.findings[0]?.dismissal);
  expect(restored.verdict).toBe("APPROVE");
  expect(restored.actionSummary).toBeUndefined();
  for (const patch of [{ impact: "A different consequence." }, { severity: "BLOCKING" as const }, { location: { path: "another.ts", line: 1, symbol: null } }]) {
    const changed = { ...next, findings: next.findings.map(finding => ({ ...finding, ...patch })) };
    expect(preserveFindingDismissals(changed, accepted).findings[0]?.dismissal).toBeUndefined();
  }
});
