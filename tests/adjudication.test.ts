import { expect, test } from "bun:test";
import { asSchema } from "ai";
import {
  adjudicationContext,
  assembleDraftFromAssessments,
  applyFindingPresentations,
  reviewAdjudicationDraftSchema,
} from "../src/review/adjudication";
import {
  aggregateLaneCompletedReportSchema,
  writeLaneCheckpoint,
  readLaneCheckpoint,
  type LaneCompletedReport,
} from "../src/review/lane-checkpoint";
import {
  assembleCanonicalReviewReport,
  beginReportAssembly,
} from "../src/review/report-assembly";

function report(): LaneCompletedReport {
  return aggregateLaneCompletedReportSchema.parse({
    axis: "engineering-quality",
    scope: {
      claim: "Keep retries idempotent",
      dirtyState: "Clean exact head",
      inspectedSupportingContext: [],
    },
    coverage: { staticOnly: [], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [
      {
        commandOrAction: "bun test retries",
        result: "repeated request produced one write",
      },
    ],
    candidates: [],
    verifiedClaims: ["Retries preserve the original identity"],
    limitations: [],
    specialistChecks: null,
    requirementChecks: [],
  });
}

test("passing coverage is retained in canonical assembly without being transcribed by a model", () => {
  const assessed = report();
  assessed.probes = Array.from({ length: 150 }, (_, i) => ({
    commandOrAction: `check ${i}`,
    result: `observed passing result ${i}`,
  }));
  const judgment = {
    actionSummary: "The requested checks passed.",
    additionalConcerns: [],
    freshFindings: [],
  };
  const draft = assembleDraftFromAssessments(judgment, [assessed]);
  const canonical = assembleCanonicalReviewReport({
    draft,
    state: beginReportAssembly({
      executionRevision: "review-report-v2",
      repositoryId: "R_1",
      pullRequest: 1,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      patchFingerprint: "c".repeat(64),
      planKind: "full",
      baselineHead: null,
      reviewPaths: ["src/a.ts"],
      activeAxes: ["engineering-quality"],
      selectedFindingIds: [],
    }),
    priorReport: null,
    generatedAt: "2026-09-13T12:00:00Z",
  }).report!;
  expect(canonical.probes).toEqual(assessed.probes);
  expect(canonical.verifiedClaims).toEqual(assessed.verifiedClaims);
  const context = adjudicationContext([assessed], null);
  expect(context.assessments[0]!.verification.probes).toBe(150);
  expect(JSON.stringify(context)).not.toContain("observed passing result 149");
  expect(canonical.verdict).toBe("APPROVE");
});

test("failed requirements and contradictory passing observations both reach judgment", () => {
  const passed = report(),
    failed = report();
  const check = {
    sourceId: `req-${"a".repeat(24)}`,
    obligationId: null,
    requirement: "Reject invalid input",
    establishedRequirement: "Reject invalid input",
    basis: "established" as const,
    proposedChange: "Parser update",
    approvalEvidence: null,
    expected: "Invalid request is rejected",
    observed: "Request rejected",
    action: "Call public API",
    environment: "exact head",
    status: "passed" as const,
  };
  passed.requirementChecks = [check];
  failed.requirementChecks = [
    { ...check, status: "failed", observed: "Invalid request accepted" },
  ];
  const context = adjudicationContext([passed, failed], null);
  expect(
    context.assessments.map((item) => item.requirementConcerns[0]?.status),
  ).toEqual(["passed", "failed"]);
  expect(() =>
    assembleDraftFromAssessments(
      { actionSummary: "Checked", additionalConcerns: [], freshFindings: [] },
      [failed],
    ),
  ).toThrow("material claim finding");
});

test("presentation cannot edit severity, technical evidence, identity or lifecycle", async () => {
  const presentation = {
    id: "CR-1",
    introduction:
      "This retry rides twice through the same write path, so a repeated webhook can duplicate the review even after its first delivery succeeded. Preserve the recorded idempotency key before publishing again.",
  };
  expect(
    reviewAdjudicationDraftSchema.safeParse({
      actionSummary: "Checked",
      additionalConcerns: [],
      freshFindings: [],
      presentations: [{ ...presentation, severity: "NITPICK" }],
    }).success,
  ).toBe(false);
  const base = assembleCanonicalReviewReport({
    draft: assembleDraftFromAssessments(
      {
        actionSummary: "Checked",
        additionalConcerns: [],
        freshFindings: [
          {
            category: "QUALITY",
            severity: "IMPORTANT",
            title: "Preserve retry identity",
            location: { path: "src/a.ts", line: 1, symbol: null },
            evidence: ["Two writes were observed"],
            impact: "Duplicate review output",
            impactSummary: "Duplicate review output",
            remedy: "Reuse the recorded key",
            staticOnly: false,
            introduction: presentation.introduction,
            principle: "Retries preserve idempotency",
            risk: "Repeated delivery duplicates output.",
            churn: null,
            requirementIds: [],
          },
        ],
      },
      [report()],
    ),
    state: beginReportAssembly({
      executionRevision: "review-report-v2",
      repositoryId: "R_1",
      pullRequest: 1,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      patchFingerprint: "c".repeat(64),
      planKind: "full",
      baselineHead: null,
      reviewPaths: ["src/a.ts"],
      activeAxes: ["engineering-quality"],
      selectedFindingIds: [],
    }),
    priorReport: null,
    generatedAt: "2026-09-13T12:00:00Z",
  }).report!;
  const updated = applyFindingPresentations(base, [
    {
      ...presentation,
      introduction:
        "A repeated webhook can duplicate the review because this path creates a new write identity for each delivery. Reusing the recorded identity keeps retries consistent with the operation that already succeeded.",
    },
  ]);
  expect({
    ...updated.findings[0]!,
    introduction: base.findings[0]!.introduction,
  }).toEqual({
    ...base.findings[0]!,
    introduction: base.findings[0]!.introduction,
  });
  expect(updated.verdict).toBe(base.verdict);
  expect(() =>
    applyFindingPresentations(base, [{ ...presentation, id: "CR-99" }]),
  ).toThrow("existing finding");
  const schema = await asSchema(reviewAdjudicationDraftSchema).jsonSchema;
  for (const field of [
    "scope",
    "coverage",
    "churn",
    "probes",
    "verifiedClaims",
    "limitations",
  ])
    expect(schema).not.toHaveProperty(`properties.${field}`);
});

test("large canonical aggregate survives checkpoint persistence without a worker response size restriction", async () => {
  const assessed = report();
  assessed.probes = Array.from({ length: 150 }, (_, i) => ({
    commandOrAction: `probe ${i}`,
    result: "Observed source and behavioral evidence. ".repeat(25),
  }));
  const files = new Map<string, string>();
  const sandbox = {
    async readTextFile({ path }: { path: string }) {
      return files.get(path) ?? null;
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      files.set(path, content);
    },
  };
  const identity = {
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    patchFingerprint: "c".repeat(64),
    evidenceDigest: "d".repeat(64),
  };
  const checkpoint = {
    status: "complete" as const,
    reviewedEntries: [0],
    remainingEntries: [],
    observations: [],
    nextSteps: [],
    limitations: [],
    completedReport: assessed,
  };
  expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeGreaterThan(65_536);
  await writeLaneCheckpoint(
    sandbox,
    identity,
    "engineering-quality",
    checkpoint,
    1,
  );
  expect(
    (await readLaneCheckpoint(sandbox, identity, "engineering-quality"))!
      .completedReport!.probes,
  ).toEqual(assessed.probes);
});
