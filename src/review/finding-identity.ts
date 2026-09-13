import { createHash } from "node:crypto";
import { findingIsOutstanding, type ReviewReport, type ReviewFinding } from "./findings";

function normalizeIdentityText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

export function findingIdentity(
  finding: Pick<ReviewFinding, "category" | "title" | "impact" | "remedy">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        category: finding.category,
        cause: normalizeIdentityText(finding.title),
        invariant: normalizeIdentityText(finding.impact),
        remedy: normalizeIdentityText(finding.remedy),
      }),
    )
    .digest("hex");
}

/** Reapply only application-recorded acceptance of the same concern and scope. */
export function preserveFindingDismissals(report: ReviewReport, prior: ReviewReport | null): ReviewReport {
  if (!prior) return report;
  const accepted = new Map(prior.findings.filter(finding => finding.dismissal).map(finding => [findingIdentity(finding), finding]));
  let changed = false;
  const findings = report.findings.map(finding => {
    const previous = accepted.get(findingIdentity(finding));
    if (finding.dismissal || finding.status === "fixed" || !previous?.dismissal
      || previous.location.path !== finding.location.path || previous.severity !== finding.severity) return finding;
    changed = true;
    return { ...finding, status: "deferred" as const, dismissal: previous.dismissal };
  });
  if (!changed) return report;
  const outstanding = findings.filter(findingIsOutstanding);
  const verdict = outstanding.some(finding => finding.severity === "BLOCKING" || finding.severity === "IMPORTANT")
    ? "REQUEST_CHANGES" : outstanding.length ? "APPROVE_WITH_IMPROVEMENTS" : "APPROVE";
  const { actionSummary: _staleSummary, ...rest } = report;
  return { ...rest, findings, verdict };
}
