import { defineWorkflowTool, toolOutput, type WorkflowToolContext } from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata } from "workflow";
import { orchestrateReview, reviewWorkflowInputSchema, type ReviewOrchestrationPlan, type PreparedWorkUnit } from "../../../../../src/review/orchestration";
import { reusableReviewWork, verifyReviewWorkReceipt, recordReviewWorkDispatch } from "../../../../../agent/lib/review-workflow";
import { fixtureWorkPlan, fixtureWorkReader, refreshFixtureWorkHandles } from "../lib/work-fixture";

export default defineWorkflowTool({ description: "Exercise the production component protocol with signed synthetic evidence.", inputSchema: reviewWorkflowInputSchema,
  async execute({ context }, ctx) {
    "use workflow";
    if (ctx.session.parent) throw new FatalError("Only the review coordinator can orchestrate work");
    using lock = createHook({ token: `known-good-review:orchestration:${ctx.session.id}` });
    if (await lock.getConflict()) throw new FatalError("Another workflow owns this review orchestration");
    const plan = await readPlan(ctx, context);
    const runId = getWorkflowMetadata().workflowRunId;
    if (typeof runId !== "string") throw new FatalError("Missing workflow identity");
    const result = await orchestrateReview({ plan, invocationPrefix: runId, abortSignal: ctx.abortSignal,
      call: async (dispatch,expectedSessionId) => { await dispatchIntent(ctx, plan.prepared.patchFingerprint, dispatch.key, expectedSessionId); return ctx.agent({ ...dispatch, ...(context === "KGR-EVAL-LOST-HANDLE" && expectedSessionId ? { agentId: "ag_missing_native_handle" } : {}), target: "agent" }); },
      reuseWork: unit => reuse(ctx, plan, unit), verifyWork: (raw,unit,key,previousSessionId) => verify(ctx, plan, raw, unit, key, previousSessionId),
      cancelOutstanding: async () => {},
    });
    return { complete: result.complete, activeAxes: result.activeAxes };
  }, toModelOutput: toolOutput.json,
});
async function readPlan(ctx: WorkflowToolContext, context: string) { "use step"; return fixtureWorkPlan(ctx.session.id, context); }
async function reuse(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, unit: PreparedWorkUnit) { "use step"; return reusableReviewWork(fixtureWorkReader(ctx.session.id), plan, unit); }
async function verify(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, raw: unknown, unit: PreparedWorkUnit, key: string, previousSessionId?: string) {
  "use step";
  await refreshFixtureWorkHandles(ctx.session.id);
  return verifyReviewWorkReceipt({ raw, unit, invocationId: `${ctx.callId}:${key}`, plan, reader: fixtureWorkReader(ctx.session.id), ...(previousSessionId ? { previousSessionId } : {}) });
}

async function dispatchIntent(ctx: WorkflowToolContext, patch: string, key: string, expectedSessionId?: string) {
  "use step";
  await recordReviewWorkDispatch(fixtureWorkReader(ctx.session.id), patch, { rootSessionId: ctx.session.id, invocationId: `${ctx.callId}:${key}`, expectedSessionId: expectedSessionId ?? null });
}
