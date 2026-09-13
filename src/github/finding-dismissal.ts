import { findingIsOutstanding, type ReviewReport } from "../review/findings";
import type { ReviewState } from "./review-state";

export interface FindingDismissalCommand {
  readonly findingId: string;
  readonly reason: string;
}

export function parseFindingDismissal(body: string): FindingDismissalCommand | null {
  const match = /^@(?:slop-sheriff|known-good-review)\s+dismiss\s+(CR-[1-9]\d*)\s+([^\r\n]+)$/i.exec(body.trim());
  const findingId = match?.[1]?.toUpperCase();
  const reason = match?.[2]?.trim();
  return findingId && reason && reason.length <= 500 ? { findingId, reason } : null;
}

/** Maintainer acknowledgement changes disposition; it never supplies fix evidence. */
export function dismissFinding(input: {
  readonly command: FindingDismissalCommand;
  readonly authorized: boolean;
  readonly actor: string;
  readonly commentId: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly state: ReviewState;
}): ReviewReport {
  if (!input.authorized) throw new Error("Dismissing a finding requires write, maintain, or admin repository permission.");
  const { state } = input;
  const baseline = state.baseline;
  if (!baseline || state.initialFullStatus !== "completed" || state.failure || state.pendingPublication
    || baseline.head !== input.headSha || baseline.report.scope.head !== input.headSha
    || baseline.report.scope.base !== input.baseSha) {
    throw new Error("A dismissal requires a completed review of the current base and head.");
  }
  if (!/^[a-f0-9]{40}$/.test(input.headSha) || !input.actor.trim()
    || !Number.isSafeInteger(input.commentId) || input.commentId <= 0 || !input.command.reason.trim()) {
    throw new Error("Dismissal attribution is incomplete.");
  }
  const selected = baseline.report.findings.find(finding => finding.id === input.command.findingId);
  if (!selected) throw new Error("That finding does not belong to the current review.");
  if (selected.status === "fixed") throw new Error("That finding already has a verified fix.");
  if (selected.dismissal) return baseline.report;
  const findings = baseline.report.findings.map(finding => finding.id !== selected.id ? finding : {
    ...finding, status: "deferred" as const,
    dismissal: { reason: input.command.reason.trim(), actor: input.actor, head: input.headSha, commentId: String(input.commentId) },
  });
  const outstanding = findings.filter(findingIsOutstanding);
  const verdict = outstanding.some(finding => finding.severity === "BLOCKING" || finding.severity === "IMPORTANT")
    ? "REQUEST_CHANGES" : outstanding.length ? "APPROVE_WITH_IMPROVEMENTS" : "APPROVE";
  // The generated action summary describes the old finding set.
  const { actionSummary: _previousSummary, ...report } = baseline.report;
  return { ...report, findings, verdict };
}
