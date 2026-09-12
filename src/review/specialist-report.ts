import type { LaneCompletedReport } from "./lane-checkpoint";
import type { ReviewReportDraft } from "./report-assembly";

/** Signed specialist evidence reaches publication even when coordinator prose omits it. */
export function retainSpecialistEvidence(draft: ReviewReportDraft, reports: readonly LaneCompletedReport[]): ReviewReportDraft {
  const probes = [...draft.probes];
  const limitations = new Set(draft.limitations);
  const staticOnly = new Set(draft.coverage.staticOnly);
  const unreached = new Set(draft.coverage.unreached);
  for (const report of reports) {
    for (const check of report.requirementChecks ?? []) {
      if (check.status === "failed" && !draft.freshFindings.some((finding) =>
        finding.category === "CLAIM" && (finding.severity === "BLOCKING" || finding.severity === "IMPORTANT") && finding.requirementIds.includes(check.sourceId))) {
        throw new Error(`Failed requirement ${check.sourceId} must remain a material claim finding`);
      }
      const label = `${report.axis}: ${check.requirement} [${check.status}; ${check.sourceId}; ${check.obligationId ?? "document context"}]`;
      const result = `${label}\nEstablished: ${check.establishedRequirement}\nProposed: ${check.proposedChange}\nApproval: ${check.approvalEvidence ?? "none evidenced"}\nExpected: ${check.expected}\nObserved: ${check.observed}`;
      const commandOrAction = `${check.environment}\n${check.action}`;
      if (!probes.some((probe) => probe.commandOrAction === commandOrAction && probe.result === result)) probes.push({ commandOrAction, result });
      if (check.status === "failed" || check.status === "unverified") limitations.add(`${label}: ${check.observed}`);
      if (check.status === "unverified") unreached.add(label);
    }
    for (const check of report.specialistChecks ?? []) {
      const label = `${report.axis}: ${check.requirement} [${check.status}; entries ${check.entries.join(", ")}]`;
      const result = `${label}\nSource: ${check.source}\nExpected: ${check.expected}\nObserved: ${check.observed}`;
      const commandOrAction = `${check.environment}\n${check.action}`;
      if (!probes.some((probe) => probe.commandOrAction === commandOrAction && probe.result === result)) probes.push({ commandOrAction, result });
      if (check.status === "failed" || check.status === "unverified" || check.status === "out-of-scope") limitations.add(`${label}: ${check.observed}`);
      if (check.status === "unverified") {
        staticOnly.add(label);
        unreached.add(`${label}: ${check.observed}`);
      }
    }
  }
  return { ...draft, probes, limitations: [...limitations], coverage: { staticOnly: [...staticOnly], unreached: [...unreached] } };
}
