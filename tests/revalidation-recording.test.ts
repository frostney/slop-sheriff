import { reviewPolicyDigest } from "../src/config/review-policy-identity";
import { expect, spyOn, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import recordTool from "../agent/tools/record_review_revalidation";
import * as adapters from "../src/github/chat-adapter";
import { reviewReportState } from "../agent/lib/review-report";
import { reviewRecoveryState } from "../agent/lib/review-recovery";
import { beginReportAssembly, type ReportAssemblyState } from "../src/review/report-assembly";
import { advanceReviewRecovery, beginReviewRecovery, type ReviewRecoveryState } from "../src/review/recovery";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { encodeReviewState } from "../src/github/review-state";
import type { ReviewFinding, ReviewReport } from "../src/review/findings";

test("revalidation rejects unsupported fixes before immutable recording and accepts corrected evidence", async () => {
  const original: ReviewFinding = {
    id: "CR-1", category: "QUALITY", severity: "IMPORTANT", status: "deferred", title: "Requests hang",
    location: { path: "src/api.ts", line: 1, symbol: null }, evidence: ["Source review cannot verify the timeout."],
    impact: "Requests do not terminate.", impactSummary: "Requests do not terminate.", remedy: "Apply the timeout.", staticOnly: true, churn: null,
  };
  const prior: ReviewReport = {
    schemaVersion: 2, kind: "code-review", generatedAt: "2026-09-11T00:00:00.000Z", verdict: "REQUEST_CHANGES",
    scope: { base: "a".repeat(40), head: "d".repeat(40), claim: "Timeout requests", dirtyState: "clean" },
    coverage: { activeAxes: ["engineering-quality"], skippedAxes: [], staticOnly: [], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [], findings: [original], verifiedClaims: [], limitations: [],
  };
  const identity = { reviewPolicyDigest: reviewPolicyDigest("", "a".repeat(40)), executionRevision: "review-report-v2" as const, repositoryId: "R_repo", pullRequest: 1,
    baseSha: prior.scope.base, headSha: "b".repeat(40), patchFingerprint: "c".repeat(64), planKind: "delta" as const,
    baselineHead: prior.scope.head, reviewPaths: ["src/api.ts"], activeAxes: ["engineering-quality" as const], selectedFindingIds: ["CR-1"] };
  let report: ReportAssemblyState | null = beginReportAssembly(identity);
  let recovery: ReviewRecoveryState | null = advanceReviewRecovery(beginReviewRecovery({ identity, activeAxes: identity.activeAxes, selectedFindingIds: identity.selectedFindingIds }), { stage: "axes-complete", completedAxes: identity.activeAxes });
  const stateBody = encodeReviewState({ schemaVersion: 2, app: "known-good-review", pullRequest: 1, initialFullStatus: "completed", updatedAt: prior.generatedAt,
    baseline: { head: prior.scope.head, patchFingerprint: "e".repeat(64), files: {}, report: prior, findingsArtifactUrl: "https://github.com/acme/repo/runs/1", findingRuntimeRequirements: { "CR-1": true } } });
  const octokit = new Octokit({ request: { fetch: async () => Response.json([{ id: 1, body: stateBody, user: { id: 123, login: "known-good-review[bot]", type: "Bot" } }]) } });
  const mocks = [
    spyOn(reviewReportState, "get").mockImplementation(() => report),
    spyOn(reviewReportState, "update").mockImplementation((update) => { report = update(report); }),
    spyOn(reviewRecoveryState, "get").mockImplementation(() => recovery),
    spyOn(reviewRecoveryState, "update").mockImplementation((update) => { recovery = update(recovery); }),
    spyOn(adapters, "githubAdapter").mockReturnValue({ octokit } as ReturnType<typeof adapters.githubAdapter>),
  ];
  try {
    const execute = recordTool.execute;
    if (!execute) throw new Error("Missing executor");
    const auth = withTrustedReviewContext({ principalId: "fixture", principalType: "user", authenticator: "github", attributes: { installation_id: "1", repository: "acme/repo", pull_request_number: "1" } },
      { ...identity, configSource: "", event: "synchronize", repositoryDatabaseId: 1, repositoryCreatedAt: 0, plan: JSON.stringify({ ...identity, kind: "delta" }), reviewFiles: [{ path: "src/api.ts", status: "modified" }] });
    const ctx = { session: { auth: { current: auth } } } as unknown as Parameters<typeof execute>[1];
    await expect(execute({ findings: [{ ...original, status: "fixed" }] }, ctx)).rejects.toThrow("requires runtime evidence");
    expect(report?.revalidatedFindings).toEqual([]);
    expect(recovery?.stage).toBe("axes-complete");
    await expect(execute({ findings: [{ ...original, status: "open", evidence: ["Verbose observation. ".repeat(100)] }] }, ctx)).rejects.toThrow("200-word inline limit");
    expect(report?.revalidatedFindings).toEqual([]);
    await execute({ findings: [{ ...original, status: "fixed", staticOnly: false, evidence: ["CLI timeout probe terminates at the configured deadline."] }] }, ctx);
    expect(report?.revalidatedFindings[0]?.status).toBe("fixed");
    expect(recovery?.stage).toBe("revalidation-complete");
  } finally { for (const mock of mocks) mock.mockRestore(); }
});
