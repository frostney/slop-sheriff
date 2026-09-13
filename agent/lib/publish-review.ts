import { lifecycleConfigured } from "../../src/lifecycle/client";
import type { Octokit } from "@octokit/rest";
import type { ReviewConfig } from "../../src/config/review-config";
import {
  pendingReviewPublication,
  publishReview,
  validateReportPublicationIdentity,
} from "../../src/github/publication";
import type { TrustedGitHubContext } from "../../src/github/trusted-context";
import {
  reportAssemblyStateSchema,
  type ReportAssemblyState,
} from "../../src/review/report-assembly";
import {
  enqueueReviewMemory,
  normalizedReviewMemory,
} from "../../src/memory/client";

export async function publishPendingReview(input: {
  readonly config: ReviewConfig;
  readonly context: TrustedGitHubContext;
  readonly octokit: Octokit;
  readonly staged?: ReportAssemblyState;
}) {
  const pending = input.staged
    ? reportAssemblyStateSchema.parse(input.staged)
    : await pendingReviewPublication({
        context: input.context,
        octokit: input.octokit,
      });
  validateReportPublicationIdentity(input.context, pending.identity);
  if (!pending.report) {
    throw new Error("No validated review report is pending publication");
  }
  const publication = await publishReview({
    config: input.config,
    context: input.context,
    octokit: input.octokit,
    report: pending.report,
  });
  if (lifecycleConfigured()) return { ...publication, memory: { status: "pending-publication" as const } };
  const memory = await enqueueReviewMemory(
    normalizedReviewMemory({
      config: input.config,
      context: input.context,
      report: pending.report,
      reviewKind: pending.identity.planKind,
    }),
  );
  return { ...publication, memory };
}
