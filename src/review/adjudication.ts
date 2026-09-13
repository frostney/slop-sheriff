import { z } from "zod";
import {
  findingProseSchema,
  type ReviewReport,
  type ReviewFinding,
} from "./findings";
import type { LaneCompletedReport } from "./lane-checkpoint";
import {
  reviewReportDraftSchema,
  type ReviewReportDraft,
} from "./report-assembly";
import { retainSpecialistEvidence } from "./specialist-report";

/** The model judges concerns and writes the public explanation. Coverage and
 * executed evidence are assembled from application-verified assessments. */
export const reviewAdjudicationDraftSchema = reviewReportDraftSchema
  .pick({
    actionSummary: true,
    additionalConcerns: true,
    freshFindings: true,
  })
  .extend({
    presentations: z
      .array(
        z.strictObject({
          id: z.string().regex(/^CR-[1-9]\d*$/),
          introduction: findingProseSchema,
        }),
      )
      .optional(),
  });
export type ReviewAdjudicationDraft = z.infer<
  typeof reviewAdjudicationDraftSchema
>;

function unique<T>(items: readonly T[]): T[] {
  return [
    ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
  ];
}

export function assembleDraftFromAssessments(
  draft: ReviewAdjudicationDraft,
  reports: readonly LaneCompletedReport[],
  retainedFindings: readonly ReviewFinding[] = [],
): ReviewReportDraft {
  if (reports.length === 0)
    throw new Error("Adjudication requires completed technical assessments");
  const union = (get: (report: LaneCompletedReport) => string[]) =>
    unique(reports.flatMap(get));
  return retainSpecialistEvidence(
    {
      actionSummary: draft.actionSummary,
      additionalConcerns: draft.additionalConcerns,
      freshFindings: draft.freshFindings,
      scope: {
        claim: union((report) => [report.scope.claim]).join("\n\n"),
        dirtyState: union((report) => [report.scope.dirtyState]).join("\n\n"),
      },
      coverage: {
        staticOnly: union((report) => report.coverage.staticOnly),
        unreached: union((report) => report.coverage.unreached),
      },
      churn: {
        window: union((report) => [report.churn.window]).join("; "),
        symbolCoverage: union((report) => report.churn.symbolCoverage),
        fileFallbacks: union((report) => report.churn.fileFallbacks),
      },
      probes: unique(
        reports.flatMap((report) =>
          report.probes.map(({ commandOrAction, result }) => ({
            commandOrAction,
            result,
          })),
        ),
      ),
      verifiedClaims: union((report) => report.verifiedClaims),
      limitations: union((report) => report.limitations),
    },
    reports,
    retainedFindings,
  );
}

/** All failures and conflicting observations enter judgment; ordinary passing
 * coverage remains in the canonical artifact without a model transcription. */
export function adjudicationContext(
  reports: readonly LaneCompletedReport[],
  prior: ReviewReport | null,
) {
  const disputed = new Set(
    reports.flatMap((report) =>
      (report.requirementChecks ?? [])
        .filter(
          (check) => check.status === "failed" || check.status === "unverified",
        )
        .map((check) => `${check.sourceId}/${check.obligationId}`),
    ),
  );
  return {
    assessments: reports.map((report) => ({
      axis: report.axis,
      candidates: report.candidates,
      requirementConcerns: (report.requirementChecks ?? []).filter((check) =>
        disputed.has(`${check.sourceId}/${check.obligationId}`),
      ),
      specialistConcerns: (report.specialistChecks ?? []).filter(
        (check) => check.status === "failed" || check.status === "unverified",
      ),
      verification: {
        requirementChecks: report.requirementChecks?.length ?? 0,
        specialistChecks: report.specialistChecks?.length ?? 0,
        probes: report.probes.length,
      },
      limitations: report.limitations,
      unreached: report.coverage.unreached,
    })),
    priorFindings: prior?.findings ?? [],
    evidenceAssembly:
      "The application retains full scope, checks, probes, churn and verified claims. Judge the concerns; do not transcribe passing evidence. Use presentations only to rewrite an existing finding introduction for the configured voice, keeping its technical substance unchanged.",
  };
}

/** Presentation can change introductions only. Technical facts, identity,
 * severity, location, lifecycle and merge recommendation are immutable here. */
export function applyFindingPresentations(
  report: ReviewReport,
  presentations: ReviewAdjudicationDraft["presentations"],
): ReviewReport {
  const values = presentations ?? [];
  const byId = new Map(values.map((value) => [value.id, value.introduction]));
  if (
    byId.size !== values.length ||
    values.some(
      (value) => !report.findings.some((finding) => finding.id === value.id),
    )
  )
    throw new Error(
      "Presentation must name each existing finding at most once",
    );
  return {
    ...report,
    findings: report.findings.map((finding) =>
      byId.has(finding.id)
        ? { ...finding, introduction: byId.get(finding.id)! }
        : finding,
    ),
  };
}
