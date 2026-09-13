import { z } from "zod";
import { laneCheckpointContentSchema, aggregateLaneCompletedReportSchema, validateLaneCheckpointCoverage, type LaneCompletedReport } from "./lane-checkpoint";
import { reviewWorkUnitSchema, reviewWorkPlanSchema, workHash, type ReviewWorkUnit, type ReviewWorkPlan } from "./work-plan";
import type { ReviewEvidenceManifest } from "./evidence-bundle";
import { isSpecialistAxis } from "./specialist-scope";
import { workDigestSchema, type CompletedWorkKey } from "./work-storage-contracts";

/** Proof is application-owned JSON. Its concrete dependency schema belongs to the planner. */
export const reviewWorkAssessmentSchema = z.strictObject({
  schemaVersion: z.literal(1), unit: reviewWorkUnitSchema, inputDigest: workDigestSchema,
  sourceBaseSha: z.string().regex(/^[a-f0-9]{40}$/), sourceHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
  proof: z.json(), checkpoint: laneCheckpointContentSchema,
});
export type ReviewWorkAssessment = z.infer<typeof reviewWorkAssessmentSchema>;
export type WorkProofValidator = (assessment: ReviewWorkAssessment, expectedUnit: ReviewWorkUnit) => Promise<boolean>;
type Obligation = { readonly id: string; readonly sourceId: string };

/** An unfinished checkpoint has its own immutable history; it never replaces a completion. */
export function workAssessmentStorageKey(assessment: ReviewWorkAssessment): CompletedWorkKey {
  const parsed = reviewWorkAssessmentSchema.parse(assessment);
  return parsed.checkpoint.status === "complete"
    ? { scopeKey: parsed.unit.id, inputDigest: parsed.inputDigest }
    : { scopeKey: workHash([parsed.unit.id, "progress"]), inputDigest: workHash([parsed.inputDigest, parsed.checkpoint]) };
}
export function workProgressScopeKey(unit: ReviewWorkUnit): string { return workHash([unit.id, "progress"]); }

export async function validateWorkAssessment(raw: unknown, expectedUnit: ReviewWorkUnit, input: {
  readonly inputDigest: string; readonly obligations: readonly Obligation[]; readonly validateProof: WorkProofValidator;
  readonly requireComplete?: boolean;
}): Promise<ReviewWorkAssessment> {
  const assessment = reviewWorkAssessmentSchema.parse(raw);
  const unit = reviewWorkUnitSchema.parse(expectedUnit);
  if (JSON.stringify(assessment.unit) !== JSON.stringify(unit) || assessment.inputDigest !== input.inputDigest) throw new Error("Work assessment does not match the current semantic unit");
  if (new Set(unit.paths).size !== unit.paths.length || new Set(unit.requirementIds).size !== unit.requirementIds.length) throw new Error("Work unit scope contains duplicate paths or requirements");
  if (assessment.checkpoint.completedReport && assessment.checkpoint.completedReport.axis !== unit.axis) throw new Error("Work assessment report axis does not match its unit");
  if (input.requireComplete && assessment.checkpoint.status !== "complete") throw new Error("Work assessment is not complete");
  validateLaneCheckpointCoverage(assessment.checkpoint, unit.paths.length, unit.requirementIds, input.obligations.filter(obligation => unit.requirementIds.includes(obligation.sourceId)));
  if (!await input.validateProof(assessment, unit)) throw new Error("Work assessment supporting dependencies are no longer valid");
  return assessment;
}

function unique<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => { const key = JSON.stringify(value); if (seen.has(key)) return false; seen.add(key); return true; });
}
const text = (values: readonly string[]) => unique(values).join("\n\n");

/** Assemble only the exact application plan. Local specialist indices become manifest indices. */
export async function aggregateCompletedWorkResults(input: {
  readonly plan: ReviewWorkPlan; readonly manifest: Pick<ReviewEvidenceManifest, "baseSha" | "headSha" | "patchFingerprint" | "entries">;
  readonly results: readonly ReviewWorkAssessment[]; readonly obligations: readonly Obligation[];
  readonly expectedInputDigest: (unit: ReviewWorkUnit) => string | Promise<string>; readonly validateProof: WorkProofValidator;
}): Promise<LaneCompletedReport[]> {
  const plan = reviewWorkPlanSchema.parse(input.plan);
  if (plan.baseSha !== input.manifest.baseSha || plan.headSha !== input.manifest.headSha || plan.patchFingerprint !== input.manifest.patchFingerprint) throw new Error("Work plan does not match the current manifest");
  const expected = new Map(plan.units.map(unit => [unit.id, unit]));
  if (expected.size !== plan.units.length) throw new Error("Work plan contains duplicate assessment IDs");
  const records = input.results.map(value => reviewWorkAssessmentSchema.parse(value));
  const supplied = new Map(records.map(result => [result.unit.id, result]));
  if (records.length !== supplied.size || supplied.size !== expected.size || [...supplied.keys()].some(id => !expected.has(id))) throw new Error("Completed work must contain every expected unit exactly once");
  const pathIndices = new Map(input.manifest.entries.map((entry, index) => [entry.path, index]));
  if (pathIndices.size !== input.manifest.entries.length) throw new Error("Review manifest contains duplicate paths");
  const byAxis = new Map<LaneCompletedReport["axis"], LaneCompletedReport[]>();
  for (const unit of plan.units) {
    const indices = unit.paths.map(path => { const index = pathIndices.get(path); if (index === undefined) throw new Error("Work unit expands the current manifest scope"); return index; });
    const validated = await validateWorkAssessment(supplied.get(unit.id), unit, { inputDigest: await input.expectedInputDigest(unit), obligations: input.obligations, validateProof: input.validateProof, requireComplete: true });
    const report = validated.checkpoint.completedReport!;
    const mapped: LaneCompletedReport = { ...report, specialistChecks: report.specialistChecks?.map(check => ({ ...check, entries: check.entries.map(index => { const globalIndex = indices[index]; if (globalIndex === undefined) throw new Error("Specialist check expands its local work scope"); return globalIndex; }) })) ?? report.specialistChecks };
    byAxis.set(unit.axis, [...(byAxis.get(unit.axis) ?? []), mapped]);
  }
  return [...byAxis].map(([axis, reports]) => aggregateLaneCompletedReportSchema.parse({
    axis,
    scope: { claim: text(reports.map(report => report.scope.claim)), dirtyState: text(reports.map(report => report.scope.dirtyState)), inspectedSupportingContext: unique(reports.flatMap(report => report.scope.inspectedSupportingContext)) },
    coverage: { staticOnly: unique(reports.flatMap(report => report.coverage.staticOnly)), unreached: unique(reports.flatMap(report => report.coverage.unreached)) },
    churn: { window: text(reports.map(report => report.churn.window)), symbolCoverage: unique(reports.flatMap(report => report.churn.symbolCoverage)), fileFallbacks: unique(reports.flatMap(report => report.churn.fileFallbacks)) },
    probes: unique(reports.flatMap(report => report.probes)), candidates: unique(reports.flatMap(report => report.candidates)),
    verifiedClaims: unique(reports.flatMap(report => report.verifiedClaims)), limitations: unique(reports.flatMap(report => report.limitations)),
    specialistChecks: reports.some(report => report.specialistChecks != null) ? unique(reports.flatMap(report => report.specialistChecks ?? [])) : null,
    requirementChecks: reports.some(report => report.requirementChecks != null) ? unique(reports.flatMap(report => report.requirementChecks ?? [])) : null,
  }));
}

/** Exclusions are app-owned scope decisions, never fabricated specialist inspection. */
export function applyTrustedSpecialistExclusions(reports: LaneCompletedReport[], plan: Pick<ReviewWorkPlan, "units">, manifest: Pick<ReviewEvidenceManifest, "entries">): LaneCompletedReport[] {
  for (const report of reports) {
    if (!isSpecialistAxis(report.axis)) continue;
    const selected = new Set(plan.units.filter(unit => unit.axis === report.axis).flatMap(unit => unit.paths));
    const entries = manifest.entries.flatMap((entry, index) => selected.has(entry.path) ? [] : [index]);
    if (entries.length) report.specialistChecks = [...(report.specialistChecks ?? []), {
      entries, requirement: "Trusted specialist scope selection", source: "Application-owned current review work plan",
      expected: "Only paths selected for this specialist require its component assessment", environment: "Current immutable manifest",
      action: "Applied the trusted lane selection to the current changed paths",
      observed: "These paths were excluded from this specialist scope; no probe or specialist inspection is claimed", status: "out-of-scope",
    }];
  }
  return reports;
}
