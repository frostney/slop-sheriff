import { expect, test } from "bun:test";
import { reviewReportSchema } from "../src/review/findings";
import {
  reportAssessmentAssociation,
  reportRevalidationProvenance,
  retainedFindingRevalidation,
} from "../src/review/report-assessments";
import { workOrchestrationFixture } from "./work-orchestration-fixture";
import {
  beginReportAssembly,
  recordRevalidationResults,
} from "../src/review/report-assembly";
import { applyFindingPresentations } from "../src/review/adjudication";

function fixture() {
  const work = workOrchestrationFixture(["engineering-quality"]);
  const plan = work.plan.prepared;
  plan.reportRepositoryDigest = "ef".repeat(32);
  const assessments = [...work.assessments.values()];
  for (const unit of plan.units) {
    unit.status = "reused";
    unit.reusableAssessment = work.assessments.get(unit.id)!;
  }
  const priorReport = reviewReportSchema.parse({
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-09-13T12:00:00Z",
    verdict: "REQUEST_CHANGES",
    scope: {
      claim: "Keep webhook retries idempotent",
      dirtyState: "Exact head",
      base: plan.baseSha,
      head: plan.headSha,
    },
    coverage: {
      activeAxes: ["engineering-quality"],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    verifiedClaims: [],
    limitations: [],
    findings: [
      {
        id: "CR-1",
        status: "open",
        category: "QUALITY",
        severity: "IMPORTANT",
        title: "Preserve retry identity",
        location: { path: "src/retry.ts", line: 1, symbol: null },
        evidence: ["Repeated delivery creates two writes"],
        impact: "Duplicate reviews",
        impactSummary: "Duplicate reviews",
        remedy: "Reuse the existing operation key",
        staticOnly: false,
        churn: null,
      },
    ],
  });
  return {
    plan,
    assessments,
    priorReport,
    association: reportAssessmentAssociation(
      priorReport,
      assessments,
      plan.reportRepositoryDigest,
      "none",
    ),
  };
}

test("presentation can reuse the exact published evidence without changing the unresolved runtime finding", () => {
  const f = fixture();
  const findings = retainedFindingRevalidation({
    ...f,
    selectedFindingIds: ["CR-1"],
  });
  expect(findings).toEqual(f.priorReport.findings);
  const state = recordRevalidationResults(
    beginReportAssembly({
      executionRevision: "review-report-v2",
      repositoryId: "R_1",
      pullRequest: 43,
      baseSha: f.plan.baseSha,
      headSha: f.plan.headSha,
      patchFingerprint: f.plan.patchFingerprint,
      planKind: "delta",
      baselineHead: f.priorReport.scope.head,
      reviewPaths: ["src/retry.ts"],
      activeAxes: ["engineering-quality"],
      selectedFindingIds: ["CR-1"],
    }),
    findings,
  );
  const rendered = applyFindingPresentations(
    { ...f.priorReport, findings: state.revalidatedFindings },
    [
      {
        id: "CR-1",
        introduction:
          "This webhook rides through the write path twice. Reuse its operation key so retries keep their promise of one review per delivery.",
      },
    ],
  );
  expect(rendered.findings[0]?.status).toBe("open");
  expect(rendered.findings[0]?.staticOnly).toBe(false);
  expect(rendered.findings[0]?.evidence).toEqual(
    f.priorReport.findings[0]?.evidence,
  );
  expect(rendered.verdict).toBe("REQUEST_CHANGES");
});

test("fresh work, changed evidence and a different published report retain required revalidation", () => {
  const pending = fixture();
  pending.plan.units[0]!.status = "pending";
  expect(
    retainedFindingRevalidation({ ...pending, selectedFindingIds: ["CR-1"] }),
  ).toBeNull();
  const changed = fixture();
  changed.plan.units[0]!.reusableAssessment!.checkpoint.completedReport!.verifiedClaims.push(
    "Different supporting behavior was observed",
  );
  expect(
    retainedFindingRevalidation({ ...changed, selectedFindingIds: ["CR-1"] }),
  ).toBeNull();
  const wrongReport = fixture();
  wrongReport.priorReport.findings[0]!.status = "deferred";
  expect(
    retainedFindingRevalidation({
      ...wrongReport,
      selectedFindingIds: ["CR-1"],
    }),
  ).toBeNull();
  const missing = fixture();
  expect(
    retainedFindingRevalidation({
      ...missing,
      selectedFindingIds: ["CR-1"],
      association: null,
    }),
  ).toBeNull();
  expect(
    retainedFindingRevalidation({ ...missing, selectedFindingIds: ["CR-99"] }),
  ).toBeNull();
});

test("identical component evidence cannot mask changed repository inputs or legacy proof", () => {
  const changed = fixture();
  changed.plan.reportRepositoryDigest = "ab".repeat(32);
  expect(
    retainedFindingRevalidation({ ...changed, selectedFindingIds: ["CR-1"] }),
  ).toBeNull();
  const unknown = fixture();
  delete unknown.plan.reportRepositoryDigest;
  expect(
    retainedFindingRevalidation({ ...unknown, selectedFindingIds: ["CR-1"] }),
  ).toBeNull();
  const legacy = fixture();
  const { repositoryDigest: _digest, ...association } = legacy.association;
  expect(
    retainedFindingRevalidation({
      ...legacy,
      association: { ...association, schemaVersion: 1 },
      selectedFindingIds: ["CR-1"],
    }),
  ).toBeNull();
});

test("independent revalidation cannot acquire reuse authority through unchanged repository inputs", () => {
  const f = fixture();
  const input = { ...f, selectedFindingIds: ["CR-1"], revalidatedFindings: f.priorReport.findings };
  expect(reportRevalidationProvenance({ ...input, selectedFindingIds: [], revalidatedFindings: [] })).toBe("none");
  expect(reportRevalidationProvenance(input)).toBe("retained");
  const independent = reportAssessmentAssociation(f.priorReport, f.assessments, f.plan.reportRepositoryDigest, "independent-untracked");
  expect(retainedFindingRevalidation({ ...input, association: independent })).toBeNull();
  expect(reportRevalidationProvenance({ ...input, association: independent })).toBe("independent-untracked");
  const changed = structuredClone(f.priorReport.findings);
  changed[0]!.evidence.push("An independent external observation changed");
  expect(reportRevalidationProvenance({ ...input, revalidatedFindings: changed })).toBe("independent-untracked");
  expect(reportRevalidationProvenance({ ...input, association: null })).toBe("independent-untracked");
  const retained = reportAssessmentAssociation(f.priorReport, f.assessments, f.plan.reportRepositoryDigest, "retained");
  expect(retainedFindingRevalidation({ ...input, association: retained })).toEqual(f.priorReport.findings);
});


test("a prior clean report needs the same exact reuse proof before presentation-only routing", () => {
  const f = fixture();
  f.priorReport.findings = [];
  f.priorReport.verdict = "APPROVE";
  f.association = reportAssessmentAssociation(f.priorReport, f.assessments, f.plan.reportRepositoryDigest, "none");
  const input = { ...f, selectedFindingIds: [] };
  expect(retainedFindingRevalidation(input)).toEqual([]);
  expect(retainedFindingRevalidation({ ...input, association: null })).toBeNull();
  f.plan.units[0]!.status = "pending";
  expect(retainedFindingRevalidation(input)).toBeNull();
});
