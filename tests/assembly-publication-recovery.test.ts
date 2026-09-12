import { reviewPolicyDigest } from "../src/config/review-policy-identity";
import { expect, spyOn, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import assembleTool from "../agent/tools/assemble_review_report";
import * as adapters from "../src/github/chat-adapter";
import * as evidence from "../agent/lib/review-evidence";
import { reviewReportState } from "../agent/lib/review-report";
import { reviewRecoveryState } from "../agent/lib/review-recovery";
import { beginReportAssembly, type ReportAssemblyState } from "../src/review/report-assembly";
import { advanceReviewRecovery, beginReviewRecovery, type ReviewRecoveryState } from "../src/review/recovery";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import { writeLaneCheckpoint } from "../src/review/lane-checkpoint";

// Keep Eve's durable state and GitHub HTTP injectable; execute the real tool,
// canonical assembler, signed checkpoint reader, and publication staging path.
test("staging failure retains reconciliation work until GitHub has the report", async () => {
  const identity = { reviewPolicyDigest: reviewPolicyDigest("", "a".repeat(40)),
    executionRevision: "review-report-v2" as const, repositoryId: "R_repo", pullRequest: 1,
    baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64),
    planKind: "full" as const, baselineHead: null, reviewPaths: [],
    activeAxes: ["engineering-quality" as const], selectedFindingIds: [],
  };
  const checkpointIdentity = {
    baseSha: identity.baseSha, headSha: identity.headSha,
    patchFingerprint: identity.patchFingerprint, evidenceDigest: "d".repeat(64),
  };
  let report: ReportAssemblyState | null = beginReportAssembly(identity);
  let recovery: ReviewRecoveryState | null = advanceReviewRecovery(beginReviewRecovery({
    identity, activeAxes: identity.activeAxes, selectedFindingIds: [],
  }), { stage: "axes-complete", completedAxes: identity.activeAxes });
  let rejectWrite = true;
  let writes = 0;
  const octokit = new Octokit({ request: { fetch: async (_resource: Request | string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return Response.json([]);
    writes += 1;
    if (rejectWrite) return Response.json({ message: "temporary fixture failure" }, { status: 503 });
    return Response.json({ id: 1 });
  } } });
  const files = new Map<string, string>();
  const sandbox = {
    readTextFile: async ({ path }: { path: string }) => files.get(path) ?? null,
    writeTextFile: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
  };
  const secret = process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
  process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = "ef".repeat(32);
  const signed = authenticatedEvidenceSandbox(sandbox, "root", process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY);
  const draft = {
  actionSummary: "Reviewed the affected publication paths and retained the observed evidence.", additionalConcerns: [],
    scope: { claim: "Review retry behavior", dirtyState: "clean" },
    coverage: { staticOnly: [], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [], freshFindings: [], verifiedClaims: [], limitations: [],
  };
  await writeLaneCheckpoint(signed, checkpointIdentity, "engineering-quality", {
    status: "complete", reviewedEntries: [], remainingEntries: [], observations: [], nextSteps: [], limitations: [],
    completedReport: { axis: "engineering-quality", candidates: [], scope: { ...draft.scope, inspectedSupportingContext: [] },
      coverage: draft.coverage, churn: draft.churn, probes: [], verifiedClaims: [], limitations: [] },
  }, 0);
  const readReport = spyOn(reviewReportState, "get").mockImplementation(() => report);
  const writeReport = spyOn(reviewReportState, "update").mockImplementation((update) => { report = update(report); });
  const readRecovery = spyOn(reviewRecoveryState, "get").mockImplementation(() => recovery);
  const writeRecovery = spyOn(reviewRecoveryState, "update").mockImplementation((update) => { recovery = update(recovery); });
  const readIdentity = spyOn(evidence, "currentLaneCheckpointIdentity").mockResolvedValue(checkpointIdentity);
  // The tool uses only the adapter's Octokit escape hatch.
  const adapter = spyOn(adapters, "githubAdapter").mockReturnValue({ octokit } as ReturnType<typeof adapters.githubAdapter>);
  try {
    const execute = assembleTool.execute;
    if (!execute) throw new Error("Assembly tool must have an executor");
    const auth = withTrustedReviewContext({
      principalId: "fixture", principalType: "user", authenticator: "github",
      attributes: { installation_id: "1", repository: "acme/repo", pull_request_number: "1" },
    }, {
      ...identity, configSource: "", event: "opened", repositoryDatabaseId: 1, repositoryCreatedAt: 0,
      plan: JSON.stringify({ ...identity, kind: "full" }), reviewFiles: [],
    });
    const ctx = { session: { id: "root", auth: { current: auth } }, getSandbox: async () => sandbox } as unknown as Parameters<typeof execute>[1];
    await expect(execute({ draft: { ...draft, freshFindings: [{
      severity: "IMPORTANT", category: "QUALITY", title: "Preserve the review evidence",
      location: { path: "src/review.ts", line: 1, symbol: null },
      evidence: ["A concrete observation. ".repeat(60)], impact: "The report loses evidence.",
      requirementIds: [],
  introduction: "The recorded publication path can replay the same operation without reusing its identity, so a retry exposes duplicate output to readers even though the original work already finished successfully.",
  principle: "Retries must preserve the recorded publication identity.",
  risk: "A retry can duplicate output for every reader of the affected review.",
  impactSummary: "The report loses evidence.", remedy: "Retain the observation.", staticOnly: false, churn: null,
    }] } }, ctx)).rejects.toThrow("200-word inline limit");
    expect(writes).toBe(0);
    expect(report?.report).toBeNull();
    expect(recovery?.stage).toBe("axes-complete");
    await expect(execute({ draft }, ctx)).rejects.toThrow();
    expect(writes).toBe(1);
    expect(recovery?.stage).toBe("axes-complete");
    expect(report?.report).not.toBeNull();
    rejectWrite = false;
    expect(await execute({ draft }, ctx)).toMatchObject({ staged: true, recoveryStage: "report-reconciled" });
    expect(recovery?.stage).toBe("report-reconciled");
    expect(writes).toBe(2);
  } finally {
    for (const mock of [readReport, writeReport, readRecovery, writeRecovery, readIdentity, adapter]) mock.mockRestore();
    if (secret === undefined) delete process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
    else process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = secret;
  }
});
