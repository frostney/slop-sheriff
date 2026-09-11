import { defineState, type SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  beginReportAssembly,
  reportAssemblyIdentitySchema,
  reviewAxisDecisionsSchema,
  validateReportAssemblyIdentity,
  type ReportAssemblyIdentity,
  type ReportAssemblyState,
} from "../../src/review/report-assembly";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import { reviewAxes } from "../../src/review/axes";
import { reviewFileScopeSchema } from "../../src/review/prepare-review-evidence";

const reportPlanSchema = z.object({
  kind: z.enum(["full", "delta"]),
  activeAxes: z.array(z.enum(reviewAxes)).min(1).max(reviewAxes.length),
  axisDecisions: reviewAxisDecisionsSchema.optional(),
  selectedFindingIds: z.array(z.string().regex(/^CR-[1-9]\d*$/)).max(100),
  baselineHead: z.string().nullable(),
});

export const reviewReportState = defineState<ReportAssemblyState | null>(
  "known-good-review.report",
  () => null,
);

export function reportAssemblyIdentityFromAuth(
  auth: SessionAuthContext | null | undefined,
): ReportAssemblyIdentity {
  const trusted = trustedGitHubContext(auth);
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review report is missing patch identity");
  }
  const rawPlan = auth?.attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") {
    throw new Error("Trusted review report is missing its plan");
  }
  const plan = reportPlanSchema.parse(JSON.parse(rawPlan));
  const rawFiles = auth?.attributes[reviewContextAttributes.reviewFiles];
  if (typeof rawFiles !== "string") throw new Error("Trusted review report is missing its file scope");
  const reviewPaths = reviewFileScopeSchema.parse(JSON.parse(rawFiles)).map((file) => file.path);
  return reportAssemblyIdentitySchema.parse({
    executionRevision: "review-report-v2",
    repositoryId: trusted.repositoryId,
    pullRequest: trusted.pullRequest,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    planKind: plan.kind,
    baselineHead: plan.baselineHead,
    reviewPaths,
    activeAxes: plan.activeAxes,
    ...(plan.axisDecisions ? { axisDecisions: plan.axisDecisions } : {}),
    selectedFindingIds: plan.selectedFindingIds,
  });
}

export function currentReviewReportState(
  auth: SessionAuthContext | null | undefined,
): ReportAssemblyState {
  const identity = reportAssemblyIdentityFromAuth(auth);
  const current = reviewReportState.get();
  if (current) return validateReportAssemblyIdentity(current, identity);
  const started = beginReportAssembly(identity);
  reviewReportState.update(() => started);
  return started;
}
