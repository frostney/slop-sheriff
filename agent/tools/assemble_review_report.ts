import { outsideReviewWork } from "../lib/review-capabilities";
import { parseReviewConfig } from "../../src/config/review-config";
import { routingAttribute } from "../../src/models/routing";
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
import { assembleDraftFromAssessments, applyFindingPresentations } from "../../src/review/adjudication";
import {
  assembleCanonicalReviewReport,
  validatedPriorFindings,
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
import { preparedReviewWorkPlanSchema } from "../../src/review/prepare-review-work";
import { reviewWorkPlanPath } from "../../src/review/work-plan";
import { completedReviewWorkStore } from "../../src/review/work-storage";
import { readCompletedReportAssessments, reportAssessmentAssociation, reportAssessmentKey, reportRevalidationProvenance } from "../../src/review/report-assessments";

import { assembleReviewReportInputSchema } from "../../src/review/tool-inputs";

export { assembleReviewReportInputSchema } from "../../src/review/tool-inputs";

export const reviewTool = defineTool({
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
      const technical = assembleCanonicalReviewReport({
        draft: assembleDraftFromAssessments(draft, completedReports, validatedPriorFindings(current, reviewState?.baseline?.report ?? null,
          Object.entries(reviewState?.baseline?.findingRuntimeRequirements ?? {}).filter(([, required]) => required).map(([id]) => id))),
        generatedAt: new Date().toISOString(),
        priorReport: reviewState?.baseline?.report ?? null,
        priorRuntimeFindingIds: Object.entries(reviewState?.baseline?.findingRuntimeRequirements ?? {})
          .filter(([, required]) => required).map(([id]) => id),
        state: current,
      });
      if (!technical.report) {
        throw new Error("Canonical review report assembly produced no report");
      }
      const assembled = { ...technical, report: applyFindingPresentations(technical.report, draft.presentations) };
      for (const finding of assembled.report.findings.filter((finding) => finding.status !== "fixed")) {
        try { validateFindingPresentation(finding); } catch (error) {
          throw new ReviewReportValidationError([{ code: "custom", path: ["freshFindings", finding.id] }],
            error instanceof Error ? error.message : "Finding exceeds its presentation limits");
        }
      }
      latest = assembled;
      reviewReportState.update(() => assembled);
      const workPlan = preparedReviewWorkPlanSchema.parse(JSON.parse(await sandbox.readTextFile({ path: reviewWorkPlanPath(trusted.patchFingerprint) }) ?? "null"));
      if (!trusted.deliveryId) throw new Error("Report assembly requires an admitted review attempt");
      const work = await readCompletedReportAssessments(workPlan, sandbox, trusted.deliveryId);
      const workStore = completedReviewWorkStore(trusted);
      const priorReport = reviewState?.baseline?.report ?? null;
      const priorAssociation = priorReport && current.identity.selectedFindingIds.length > 0
        ? await workStore.get(reportAssessmentKey(priorReport)) : null;
      const provenance = reportRevalidationProvenance({ plan: workPlan, priorReport,
        selectedFindingIds: current.identity.selectedFindingIds, revalidatedFindings: current.revalidatedFindings,
        association: priorAssociation ? JSON.parse(priorAssociation.data) : null });
      await workStore.put({ ...reportAssessmentKey(assembled.report),
        data: JSON.stringify(reportAssessmentAssociation(assembled.report, work, workPlan.reportRepositoryDigest, provenance)) });
      await stageReviewPublication({
        config: parseReviewConfig(String(ctx.session.auth.current?.attributes[routingAttribute] ?? "")),
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

export default outsideReviewWork(reviewTool);
