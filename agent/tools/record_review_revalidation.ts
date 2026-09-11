import { githubAdapter } from "../../src/github/chat-adapter";
import { readLatestReviewState } from "../../src/github/publication";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { validateFindingPresentation } from "../../src/github/review-presentation";
import { defineTool, toolOutput } from "eve/tools";
import {
  currentReviewReportState,
  reviewReportState,
} from "../lib/review-report";
import {
  currentRecoveryState,
  reviewRecoveryState,
} from "../lib/review-recovery";
import { advanceReviewRecovery } from "../../src/review/recovery";
import {
  recordRevalidationResults,
  reportAssemblyFailure,
  validateRevalidationEvidence,
  ReviewReportValidationError,
} from "../../src/review/report-assembly";

import { recordReviewRevalidationInputSchema } from "../../src/review/tool-inputs";

export { recordReviewRevalidationInputSchema } from "../../src/review/tool-inputs";

export default defineTool({
  description:
    "Persist the complete typed outcomes for every application-selected prior finding. The application validates exact finding IDs and advances revalidation recovery. Values are retained in durable session state for report assembly and recovery.",
  inputSchema: recordReviewRevalidationInputSchema,
  async execute({ findings }, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can record revalidation");
    }
    const recovery = currentRecoveryState(ctx.session.auth.current);
    if (
      recovery.stage !== "axes-complete" &&
      recovery.stage !== "revalidation-complete"
    ) {
      throw new Error("Finding revalidation requires complete review axes");
    }
    if (recovery.selectedFindingIds.length === 0) {
      throw new Error("This review has no selected findings to revalidate");
    }
    const current = currentReviewReportState(ctx.session.auth.current);
    try {
      const trusted = trustedGitHubContext(ctx.session.auth.current);
      const baseline = (await readLatestReviewState(githubAdapter(trusted.installationId).octokit, trusted))?.baseline;
      if (!baseline || baseline.head !== current.identity.baselineHead) {
        throw new Error("Revalidation baseline no longer matches the trusted review");
      }
      validateRevalidationEvidence(findings, baseline.report ?? null,
        Object.entries(baseline.findingRuntimeRequirements ?? {}).filter(([, required]) => required).map(([id]) => id));
      for (const finding of findings.filter((finding) => finding.status !== "fixed")) {
        try { validateFindingPresentation(finding); } catch (error) {
          throw new ReviewReportValidationError([{ code: "custom", path: ["findings", finding.id] }],
            error instanceof Error ? error.message : "Finding exceeds presentation limits");
        }
      }
      const next = recordRevalidationResults(current, findings);
      reviewReportState.update(() => next);
      const advanced = advanceReviewRecovery(recovery, {
        stage: "revalidation-complete",
      });
      reviewRecoveryState.update(() => advanced);
      return {
        recordedFindingIds: next.revalidatedFindings.map(({ id }) => id),
        recoveryStage: advanced.stage,
      };
    } catch (error) {
      reviewReportState.update(() => reportAssemblyFailure(current, error));
      throw error;
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
