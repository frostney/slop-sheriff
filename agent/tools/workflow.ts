import { defineWorkflowTool, toolOutput, type WorkflowToolContext } from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata } from "workflow";
import { orchestrateReview, reviewWorkflowInputSchema, type ReviewOrchestrationPlan } from "../../src/review/orchestration";
import { reviewOrchestrationPlan, verifyReviewLaneReceipt } from "../lib/review-workflow";
import type { ReviewAxis } from "../../src/review/axes";

export default defineWorkflowTool({
  description: "Run the application-owned lane and scout protocol for the trusted prepared review. Starts active axes concurrently, continues explicit checkpointed incomplete lanes, and reserves sixteen dispatches per admitted lane, including its scouts and continuations. Coordinator only. Actual terminal checkpoint validation and recovery remain required after completion.",
  inputSchema: reviewWorkflowInputSchema,
  async execute({ context }, ctx) {
    "use workflow";
    if (ctx.session.parent) throw new FatalError("Only the review coordinator can orchestrate lanes");
    using lock = createHook({ token: `known-good-review:orchestration:${ctx.session.id}` });
    if (await lock.getConflict()) throw new FatalError("Another workflow owns this review orchestration");
    const plan = await readPlan(ctx, context);
    const runId = getWorkflowMetadata().workflowRunId;
    if (typeof runId !== "string") throw new FatalError("Workflow run identity is unavailable");
    return await orchestrateReview({
      plan, invocationPrefix: runId,
      call: (dispatch) => ctx.agent({ ...dispatch, target: "agent" }),
      verifyLane: (raw, axis, attempt, key) => verifyLane(ctx, plan, raw, axis, attempt, key),
    });
  },
  toModelOutput: toolOutput.json,
});

async function readPlan(ctx: WorkflowToolContext, context: string) {
  "use step";
  return reviewOrchestrationPlan(ctx, context);
}

async function verifyLane(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, raw: unknown, axis: ReviewAxis, attempt: number, key: string) {
  "use step";
  try {
    return verifyReviewLaneReceipt({ raw, axis, attempt, invocationId: `${ctx.callId}:${key}`, plan, secret: process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY });
  } catch (error) {
    throw new FatalError(error instanceof Error ? error.message : "Invalid review lane receipt");
  }
}
