import type { LaneCompletedReport } from "./lane-checkpoint";
import type { ReviewProbeReceipt } from "./probe-execution";
import type { ExternalObservation } from "./external-observations";
import type { z } from "zod";
import type { reviewExecutionReferencesSchema } from "./execution-reference";
type References = z.infer<typeof reviewExecutionReferencesSchema> | undefined;

/** Free-form commands and success prose cannot stand in for observed execution. */
export function validateWorkExecutionReferences(report: LaneCompletedReport | null, probes: readonly ReviewProbeReceipt[], external: readonly ExternalObservation[]): boolean {
  if (report === null) return true;
  const executions = new Set(probes.filter(receipt => receipt.status === "completed").map(receipt => receipt.executionId));
  const observations = new Set(external.map(observation => observation.id));
  const valid = (refs: References) => (refs ?? []).every(ref => ref.kind === "probe" ? executions.has(ref.id) : observations.has(ref.id));
  const observed = (refs: References) => (refs?.length ?? 0) > 0 && valid(refs);
  const executed = (refs: References) => valid(refs) && refs?.some(ref => ref.kind === "probe") === true;
  for (const summary of report.probes) if (!observed(summary.evidenceRefs)) return false;
  for (const candidate of report.candidates) if (!valid(candidate.evidenceRefs) || !candidate.staticOnly && !observed(candidate.evidenceRefs)) return false;
  for (const check of [...report.specialistChecks ?? [], ...report.requirementChecks ?? []]) {
    if (!valid(check.evidenceRefs)) return false;
    if (report.axis === "test-against-spec" && (check.status === "passed" || check.status === "failed") && !executed(check.evidenceRefs)) return false;
  }
  return true;
}
