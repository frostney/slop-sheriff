import { defineTool } from "eve/tools";
import { z } from "zod";
import { bindCoordinatorPresentationOnly } from "../lib/review-route";
import { outsideReviewWork } from "../lib/review-capabilities";
import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { currentLaneCheckpointIdentity } from "../lib/review-evidence";
import { currentRecoveryState, reviewRecoveryState } from "../lib/review-recovery";
import { currentReviewReportState, reviewReportState } from "../lib/review-report";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { readLaneCheckpoint, type LaneCompletedReport } from "../../src/review/lane-checkpoint";
import { adjudicationContext } from "../../src/review/adjudication";
import { readLatestReviewState } from "../../src/github/publication";
import { githubAdapter } from "../../src/github/chat-adapter";
import { preparedReviewWorkPlanSchema } from "../../src/review/prepare-review-work";
import { reviewWorkPlanPath } from "../../src/review/work-plan";
import { completedReviewWorkStore } from "../../src/review/work-storage";
import { reportAssessmentKey, retainedFindingRevalidation, reportRevalidationProvenance } from "../../src/review/report-assessments";
import { recordRevalidationResults } from "../../src/review/report-assembly";
import { advanceReviewRecovery } from "../../src/review/recovery";

export const reviewTool = defineTool({
  description: "Read all supported finding candidates, failed requirements, conflicting evidence, and prior canonical findings for judgment. The application retains complete passed checks and probe evidence in the final report, so they need no model transcription. Coordinator only, after workflow completion.",
  inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    if (ctx.session.parent) throw new Error("Only the coordinator can judge completed assessments");
    bindCoordinatorPresentationOnly(false);
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    const recovery = currentRecoveryState(ctx.session.auth.current);
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const identity = await currentLaneCheckpointIdentity(ctx.session.auth.current, sandbox);
    const reports: LaneCompletedReport[] = [];
    for (const axis of recovery.activeAxes) {
      const checkpoint = await readLaneCheckpoint(sandbox, identity, axis);
      if (checkpoint?.status !== "complete" || !checkpoint.completedReport) throw new Error("Every assigned assessment must finish before judgment");
      reports.push(checkpoint.completedReport);
    }
    const prior = await readLatestReviewState(githubAdapter(trusted.installationId).octokit, trusted);
    const priorReport = prior?.baseline?.report ?? null;
    let retained: string[] = [];
    let presentationOnly = false;
    if (priorReport && (recovery.stage === "axes-complete" || recovery.stage === "revalidation-complete")) {
      const state = currentReviewReportState(ctx.session.auth.current);
      if (state.identity.baselineHead !== priorReport.scope.head) throw new Error("Published evidence no longer matches the review baseline");
      const plan = preparedReviewWorkPlanSchema.parse(JSON.parse(await sandbox.readTextFile({ path: reviewWorkPlanPath(identity.patchFingerprint) }) ?? "null"));
      if (plan.units.every(unit => unit.status === "reused")) {
        const saved = await completedReviewWorkStore(trusted).get(reportAssessmentKey(priorReport));
        const findings = saved ? retainedFindingRevalidation({ plan, priorReport, selectedFindingIds: recovery.selectedFindingIds, association: JSON.parse(saved.data) }) : null;
        if (findings !== null) {
          if (recovery.stage === "axes-complete") {
            reviewReportState.update(() => recordRevalidationResults(state, findings));
            reviewRecoveryState.update(() => advanceReviewRecovery(recovery, { stage: "revalidation-complete" }));
            presentationOnly = true;
          } else {
            presentationOnly = reportRevalidationProvenance({ plan, priorReport, selectedFindingIds: recovery.selectedFindingIds,
              revalidatedFindings: state.revalidatedFindings, association: JSON.parse(saved!.data) }) !== "independent-untracked";
          }
          if (presentationOnly) retained = findings.map(finding => finding.id);
        }
      }
    }
    bindCoordinatorPresentationOnly(presentationOnly);
    const current = currentRecoveryState(ctx.session.auth.current);
    return { ...adjudicationContext(reports, priorReport), presentationOnly,
      revalidation: { retainedFindingIds: retained, requiredFindingIds: current.stage === "axes-complete" ? current.selectedFindingIds : [],
        explanation: presentationOnly ? "The exact published assessment evidence was revalidated and reused. Prior finding statuses are retained unchanged; only presentation needs regeneration." : "Revalidate required findings before assembly." } };
  },
});
export default outsideReviewWork(reviewTool);
