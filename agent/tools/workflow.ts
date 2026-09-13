import { refreshReviewWorkNativeHandles } from "../lib/native-work-handles";
import { defineWorkflowTool, toolOutput, type WorkflowToolContext } from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata } from "workflow";
import { orchestrateReview, reviewWorkflowInputSchema, type ReviewOrchestrationPlan, type PreparedWorkUnit } from "../../src/review/orchestration";
import { reviewOrchestrationPlan, reusableReviewWork, verifyReviewWorkReceipt, finalizeReviewWork, recordReviewWorkDispatch, reviewWorkEvidenceReader as reader } from "../lib/review-workflow";
import type { ReviewWorkAssessment } from "../../src/review/work-results";
import { trustedGitHubContext } from "../../src/github/trusted-context";

export default defineWorkflowTool({
  description: "Execute the trusted prepared component work plan. Reuse verified completed work, continue unfinished work in its native child context, and aggregate exact current-head lane evidence. Coordinator only.",
  inputSchema: reviewWorkflowInputSchema,
  async execute({ context }, ctx) {
    "use workflow";
    if (ctx.session.parent) throw new FatalError("Only the review coordinator can orchestrate work");
    using lock = createHook({ token: `known-good-review:orchestration:${ctx.session.id}` });
    if (await lock.getConflict()) throw new FatalError("Another workflow owns this review orchestration");
    const plan = await readPlan(ctx, context);
    const runId = getWorkflowMetadata().workflowRunId;
    if (typeof runId !== "string") throw new FatalError("Workflow run identity is unavailable");
    const result = await orchestrateReview({ plan, invocationPrefix: runId, abortSignal: ctx.abortSignal,
      call: async (dispatch,expectedSessionId) => { await dispatchIntent(ctx, plan.prepared.patchFingerprint, dispatch.key, expectedSessionId); return ctx.agent({ ...dispatch, target: "agent" }); },
      reuseWork: unit => reuseWork(ctx, plan, unit),
      verifyWork: (raw, unit, key, previousSessionId) => verifyWork(ctx, plan, raw, unit, key, previousSessionId),
      cancelOutstanding: () => cancelWork(ctx, `${ctx.callId}:${runId}`),
    });
    return finalize(ctx, plan, result.assessments);
  }, toModelOutput: toolOutput.json,
});
async function readPlan(ctx: WorkflowToolContext, context: string) { "use step"; return reviewOrchestrationPlan(ctx, context, reader(ctx)); }
async function reuseWork(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, unit: PreparedWorkUnit) { "use step"; return reusableReviewWork(reader(ctx), plan, unit); }
async function verifyWork(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, raw: unknown, unit: PreparedWorkUnit, key: string, previousSessionId?: string) {
  "use step";
  await refreshReviewWorkNativeHandles(ctx.session.auth.current, ctx.session.id);
  try { return await verifyReviewWorkReceipt({ raw, unit, invocationId: `${ctx.callId}:${key}`, plan, reader: reader(ctx), ...(previousSessionId ? { previousSessionId } : {}) }); }
  catch (error) { throw new FatalError(error instanceof Error ? error.message : "Invalid work receipt"); }
}
async function finalize(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, assessments: readonly ReviewWorkAssessment[]) { "use step"; return finalizeReviewWork(ctx, plan, assessments, reader(ctx)); }
async function cancelWork(ctx: WorkflowToolContext, invocationPrefix: string) {
  "use step";
  const trusted = trustedGitHubContext(ctx.session.auth.current);
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("Review cancellation requires production origin");
  const response = await fetch(`https://${host}/eve/v1/review-lifecycle`, { method: "POST", headers: { authorization: `Bearer ${process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN ?? ""}`, "x-review-operation": "cancel-work", "x-review-attempt": trusted.deliveryId ?? "", "content-type": "application/json" }, body: JSON.stringify({ rootSessionId: ctx.session.id, invocationPrefix }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("Outstanding native review work cancellation remains unverified");
}

async function dispatchIntent(ctx: WorkflowToolContext, patch: string, key: string, expectedSessionId?: string) {
  "use step";
  await recordReviewWorkDispatch(reader(ctx), patch, { rootSessionId: ctx.session.id, invocationId: `${ctx.callId}:${key}`, expectedSessionId: expectedSessionId ?? null });
}
