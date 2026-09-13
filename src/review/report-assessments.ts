import { z } from "zod";
import { reviewReportSchema, type ReviewFinding, type ReviewReport } from "./findings";
import { reviewWorkAssessmentSchema, type ReviewWorkAssessment } from "./work-results";
import { workHash } from "./work-plan";
import { reviewWorkPlanFromPrepared, type PreparedReviewWorkPlan } from "./prepare-review-work";
import { reviewWorkResultArtifactSchema } from "./work-runtime";
import type { TextSandbox } from "./authenticated-evidence";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revalidationProvenanceSchema = z.enum(["none", "retained", "independent-untracked"]);
export type ReportRevalidationProvenance = z.infer<typeof revalidationProvenanceSchema>;
const reportAssessmentSetSchema = z.strictObject({
  schemaVersion: z.literal(3), reportDigest: digest, repositoryDigest: digest.nullable(),
  revalidationProvenance: revalidationProvenanceSchema,
  assessments: z.array(z.strictObject({ unitId: digest, assessmentDigest: digest })),
});

/** Exact published content owns the association, including finding statuses.
 * An unfinished later report at the same head cannot replace this evidence. */
export function reportAssessmentKey(report: ReviewReport) {
  const reportDigest = workHash(reviewReportSchema.parse(report));
  return { scopeKey: workHash(["report-assessments-v1", reportDigest]), inputDigest: reportDigest };
}

function assessmentIdentities(assessments: readonly ReviewWorkAssessment[]) {
  const values = assessments.map(raw => {
    const assessment = reviewWorkAssessmentSchema.parse(raw);
    if (assessment.checkpoint.status !== "complete") throw new Error("Only completed assessments can support a published report");
    return { unitId: assessment.unit.id, assessmentDigest: workHash(assessment) };
  }).sort((a, b) => a.unitId.localeCompare(b.unitId));
  if (new Set(values.map(value => value.unitId)).size !== values.length) throw new Error("Published assessment identities must be unique");
  return values;
}

export function reportAssessmentAssociation(report: ReviewReport, assessments: readonly ReviewWorkAssessment[], repositoryDigest: string | null | undefined,
  revalidationProvenance: ReportRevalidationProvenance) {
  return reportAssessmentSetSchema.parse({ schemaVersion: 3, reportDigest: reportAssessmentKey(report).inputDigest, repositoryDigest: repositoryDigest ?? null, revalidationProvenance,
    assessments: assessmentIdentities(assessments) });
}

/** Called after workflow completion against authenticated prepared/result files. */
export async function readCompletedReportAssessments(plan: PreparedReviewWorkPlan, reader: TextSandbox, attemptId: string): Promise<ReviewWorkAssessment[]> {
  const units = reviewWorkPlanFromPrepared(plan).units;
  return Promise.all(plan.units.map(async (unit, index) => {
    let raw: unknown = unit.reusableAssessment;
    if (unit.status !== "reused") {
      const result = await reader.readTextFile({ path: unit.resultPath });
      if (result === null) throw new Error("Published report is missing completed work");
      const artifact = reviewWorkResultArtifactSchema.parse(JSON.parse(result));
      if (artifact.attemptId !== attemptId) throw new Error("Published report work belongs to a different admitted attempt");
      raw = artifact.assessment;
    }
    const assessment = reviewWorkAssessmentSchema.parse(raw);
    if (assessment.inputDigest !== unit.inputDigest || JSON.stringify(assessment.unit) !== JSON.stringify(units[index]) ||
      assessment.checkpoint.status !== "complete") throw new Error("Published report work does not match its current plan");
    return assessment;
  }));
}

/** Retain existing statuses only when the exact published evidence set has been
 * revalidated by preparation. This never declares a new fix or closes a thread. */
export function retainedFindingRevalidation(input: {
  plan: PreparedReviewWorkPlan; priorReport: ReviewReport; selectedFindingIds: readonly string[]; association: unknown;
}): ReviewFinding[] | null {
  if (input.plan.units.some(unit => unit.status !== "reused" || !unit.reusableAssessment)) return null;
  const association = reportAssessmentSetSchema.safeParse(input.association);
  if (!association.success || association.data.reportDigest !== reportAssessmentKey(input.priorReport).inputDigest) return null;
  if (association.data.revalidationProvenance === "independent-untracked") return null;
  if (!input.plan.reportRepositoryDigest || association.data.repositoryDigest !== input.plan.reportRepositoryDigest) return null;
  const current = assessmentIdentities(input.plan.units.map(unit => unit.reusableAssessment!));
  if (JSON.stringify(current) !== JSON.stringify(association.data.assessments)) return null;
  const findings = input.selectedFindingIds.map(id => input.priorReport.findings.find(finding => finding.id === id));
  if (new Set(input.selectedFindingIds).size !== findings.length || findings.some(finding => !finding || finding.status === "fixed")) return null;
  return findings as ReviewFinding[];
}

/** Only the application derives provenance. Repository equivalence cannot
 * validate external/runtime observations made by an independent revalidation.
 * Even when retention was eligible, changed outcomes are independent work. */
export function reportRevalidationProvenance(input: {
  plan: PreparedReviewWorkPlan; priorReport: ReviewReport | null;
  selectedFindingIds: readonly string[]; revalidatedFindings: readonly ReviewFinding[]; association: unknown;
}): ReportRevalidationProvenance {
  if (input.selectedFindingIds.length === 0) return "none";
  if (!input.priorReport) return "independent-untracked";
  const retained = retainedFindingRevalidation({ ...input, priorReport: input.priorReport });
  const identities = (findings: readonly ReviewFinding[]) => [...findings].sort((a,b) => a.id.localeCompare(b.id));
  return retained && workHash(identities(retained)) === workHash(identities(input.revalidatedFindings)) ? "retained" : "independent-untracked";
}
