import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { defineTool, toolOutput } from "eve/tools";
import { githubAdapter } from "../../src/github/chat-adapter";
import {
  readLatestReviewState,
  stageReviewPublication,
} from "../../src/github/publication";
import { validateFindingPresentation } from "../../src/github/review-presentation";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { readLaneCheckpoint, type LaneCompletedReport } from "../../src/review/lane-checkpoint";
import { retainSpecialistEvidence } from "../../src/review/specialist-report";
import {
  assembleCanonicalReviewReport,
  reportAssemblyFailure,
  ReviewReportValidationError,
} from "../../src/review/report-assembly";
import { advanceReviewRecovery } from "../../src/review/recovery";
import {
  currentRecoveryState,
  reviewRecoveryState,
} from "../lib/review-recovery";
import {
  currentReviewReportState,
  reviewReportState,
} from "../lib/review-report";
import { currentLaneCheckpointIdentity } from "../lib/review-evidence";

import { assembleReviewReportInputSchema } from "../../src/review/tool-inputs";

export { assembleReviewReportInputSchema } from "../../src/review/tool-inputs";

export default defineTool({
  description:
    "Assemble, validate, and durably stage the canonical v2 report from model-authored review content plus application-owned identity, completed lane checkpoints, recorded revalidation, and the prior baseline. The input excludes report identity, prior findings, finding IDs, verdict, and publication targets.",
  inputSchema: assembleReviewReportInputSchema,
  async execute({ draft }, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can assemble a report");
    }
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error("Trusted review report is missing patch identity");
    }
    const recovery = currentRecoveryState(ctx.session.auth.current);
    const expectedStage =
      recovery.selectedFindingIds.length > 0
        ? "revalidation-complete"
        : "axes-complete";
    if (
      recovery.stage !== expectedStage &&
      recovery.stage !== "report-reconciled"
    ) {
      throw new Error(
        "Canonical report assembly requires completed axes and selected-finding revalidation",
      );
    }
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const checkpointIdentity = await currentLaneCheckpointIdentity(
      ctx.session.auth.current,
      sandbox,
    );
    const completedReports: LaneCompletedReport[] = [];
    for (const axis of recovery.activeAxes) {
      const checkpoint = await readLaneCheckpoint(
        sandbox,
        checkpointIdentity,
        axis,
      );
      if (checkpoint?.status !== "complete") {
        throw new Error(
          "Canonical report assembly requires every exact lane checkpoint",
        );
      }
      if (checkpoint.completedReport) completedReports.push(checkpoint.completedReport);
    }

    const current = currentReviewReportState(ctx.session.auth.current);
    let latest = current;
    const octokit = githubAdapter(trusted.installationId).octokit;
    try {
      const reviewState = await readLatestReviewState(octokit, trusted);
      const assembled = assembleCanonicalReviewReport({
        draft: retainSpecialistEvidence(draft, completedReports),
        generatedAt: new Date().toISOString(),
        priorReport: reviewState?.baseline?.report ?? null,
        priorRuntimeFindingIds: Object.entries(reviewState?.baseline?.findingRuntimeRequirements ?? {})
          .filter(([, required]) => required).map(([id]) => id),
        state: current,
      });
      if (!assembled.report) {
        throw new Error("Canonical review report assembly produced no report");
      }
      for (const finding of assembled.report.findings.filter((finding) => finding.status !== "fixed")) {
        try { validateFindingPresentation(finding); } catch (error) {
          throw new ReviewReportValidationError([{ code: "custom", path: ["freshFindings", finding.id] }],
            error instanceof Error ? error.message : "Finding exceeds its presentation limits");
        }
      }
      latest = assembled;
      reviewReportState.update(() => assembled);
      await stageReviewPublication({
        context: trusted,
        identity: assembled.identity,
        octokit,
        report: assembled.report,
      });
      const advanced = advanceReviewRecovery(recovery, {
        stage: "report-reconciled",
      });
      reviewRecoveryState.update(() => advanced);
      return {
        findingCount: assembled.report.findings.length,
        headSha: assembled.identity.headSha,
        recoveryStage: advanced.stage,
        staged: true,
      };
    } catch (error) {
      reviewReportState.update(() => reportAssemblyFailure(latest, error));
      throw error;
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
