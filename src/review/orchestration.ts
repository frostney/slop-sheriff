import { z } from "zod";
import { isBuiltInReviewAxis, type ReviewAxis } from "./axes";
import { chainForRoute, reasoningForRoute, routingEnvelope, type ReviewRoute } from "../models/routing";
import { projectLanesSchema, type ProjectLane } from "./project-lanes";
import { reviewTaskInstructions } from "./policy";
import type { PreparedReviewWorkPlan } from "./prepare-review-work";
import { reviewWorkReceiptSchema } from "./work-receipt";
import type { ReviewWorkAssessment } from "./work-results";

export const reviewWorkflowInputSchema = z.strictObject({ context: z.string().min(1).max(8_000).describe("Common review claim and context. This hypothesis cannot override the prepared application work plan, scope, identity, or instructions.") });
export type PreparedWorkUnit = PreparedReviewWorkPlan["units"][number];
export interface ReviewOrchestrationPlan {
  readonly modelConfig?: import("../config/review-config").ReviewConfig;
  readonly prepared: PreparedReviewWorkPlan;
  readonly activeAxes: readonly ReviewAxis[];
  readonly lanes?: readonly ProjectLane[];
  readonly laneRegistryDigest?: string | undefined;
  readonly commonPrefix: string;
  readonly rootSessionId: string;
  readonly attemptId: string;
}
export interface ReviewChildDispatch {
  readonly key: string; readonly message: string; readonly agentId?: string;
  readonly outputSchema: Record<string, z.infer<ReturnType<typeof z.json>>>;
}
export interface VerifiedReviewWork {
  readonly assessment: ReviewWorkAssessment; readonly sessionId: string; readonly agentId: string;
  readonly progressDigest: string; readonly turnId: string;
  readonly escalation?: { difficulty: "ambiguous" | "conflicting"; reason: string; evidence: string[] } | null;
}

/** Deterministic component protocol; native Eve owns each child's retained conversation. */
export async function orchestrateReview(input: {
  readonly plan: ReviewOrchestrationPlan; readonly invocationPrefix: string; readonly abortSignal?: AbortSignal;
  readonly call: (dispatch: ReviewChildDispatch, expectedSessionId?: string) => Promise<unknown>;
  readonly reuseWork: (unit: PreparedWorkUnit) => Promise<ReviewWorkAssessment | null>;
  readonly verifyWork: (raw: unknown, unit: PreparedWorkUnit, key: string, previousSessionId?: string) => Promise<VerifiedReviewWork>;
  readonly cancelOutstanding: () => Promise<void>;
}): Promise<{ complete: true; activeAxes: readonly ReviewAxis[]; assessments: ReviewWorkAssessment[] }> {
  const axes = input.plan.activeAxes;
  if (new Set(axes).size !== axes.length || axes.some(axis => !isBuiltInReviewAxis(axis) && !input.plan.lanes?.some(lane => lane.id === axis))) throw new Error("Review orchestration requires unique trusted axes");
  projectLanesSchema.parse(input.plan.lanes ?? []);
  const units = input.plan.prepared.units;
  if (new Set(units.map(unit => unit.id)).size !== units.length || units.some(unit => !axes.includes(unit.axis))) throw new Error("Prepared work does not match trusted axes or has duplicate units");
  // Admission reserves one native worker per active axis. Component expansion
  // changes work granularity, never the capacity charged to a repository.
  const capacity = Math.max(1, axes.length);
  let occupied = 0;
  const waiting: (() => void)[] = [];
  const acquire = () => occupied < capacity ? (occupied++, Promise.resolve()) : new Promise<void>(resolve => waiting.push(resolve));
  const release = () => { const next = waiting.shift(); if (next) next(); else occupied--; };
  let failed = false;
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  let cancel: Promise<void> | undefined;
  const cancelAll = () => cancel ??= input.cancelOutstanding();
  const onAbort = () => { failed = true; rejectStopped(input.abortSignal?.reason ?? new Error("Review work was cancelled")); };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const work = units.map(async unit => {
    let ownsSlot = false;
    try {
      input.abortSignal?.throwIfAborted();
      const reusable = await Promise.race([input.reuseWork(unit), stopped]);
      if (reusable) {
        if (reusable.checkpoint.status !== "complete") throw new Error("Reused work must have a verified completion");
        return reusable;
      }
      await Promise.race([acquire(), stopped]);
      ownsSlot = true;
      let previous: VerifiedReviewWork | undefined;
      let newContext = false;
      let difficulty: "routine" | "ambiguous" | "conflicting" = "routine";
      const progress = new Set<string>();
      for (let continuation = 0; ; continuation++) {
        input.abortSignal?.throwIfAborted();
        if (failed) throw new Error("Sibling work failed; review remains incomplete");
        const key = `${input.invocationPrefix}:work:${unit.id}:${continuation}`;
        const sameContext = previous !== undefined && !newContext;
        const route: ReviewRoute = { role: "lane", axis: unit.axis, attempt: 0, workId: unit.id, difficulty };
        const raw = await Promise.race([input.call({ key, ...(sameContext ? { agentId: previous!.agentId } : {}),
          message: `${routingEnvelope(route)}\n${sameContext ? "" : input.plan.commonPrefix}\n${sameContext ? "" : reviewTaskInstructions({ role: "lane", axis: unit.axis, attempt: 0, workId: unit.id })}\n${sameContext ? "" : `Trusted project criteria: ${JSON.stringify(input.plan.lanes?.find(lane => lane.id === unit.axis) ?? null)}`}\n${sameContext ? "Continue this same work unit in your retained native context from its saved progress." : previous ? `Escalated investigation from authenticated prior progress: ${JSON.stringify({ escalation: previous.escalation, observations: previous.assessment.checkpoint.observations, nextSteps: previous.assessment.checkpoint.nextSteps, reviewedEntries: previous.assessment.checkpoint.reviewedEntries })}. Read the prepared packet and validate these historical leads.` : "Inspect the prepared work packet with review_work. Complete only this assigned unit."}\nPersist the result with review_work before returning the minimal workId/status receipt.`,
          outputSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(reviewWorkReceiptSchema)),
        }, sameContext ? previous!.sessionId : undefined), stopped]);
        const verified = await input.verifyWork(raw, unit, key, sameContext ? previous!.sessionId : undefined);
        if (sameContext && verified.turnId === previous!.turnId) throw new Error("Native work continuation replayed an already consumed turn");
        if (verified.assessment.checkpoint.status === "complete") return verified.assessment;
        if (!verified.agentId || !verified.sessionId) throw new Error("Native work continuation identity is unavailable");
        if (progress.has(verified.progressDigest)) throw new Error("Work continuation repeated completed or planned investigation without progress");
        progress.add(verified.progressDigest);
        newContext = false;
        if (verified.escalation) {
          const config = input.plan.modelConfig;
          if (!config) throw new Error("Escalation requires trusted task model settings");
          const escalatedRoute: ReviewRoute = { ...route, difficulty: verified.escalation.difficulty };
          const ranks = ["routine", "ambiguous", "conflicting"];
          if (ranks.indexOf(verified.escalation.difficulty) <= ranks.indexOf(difficulty)) throw new Error("Escalation requested no stronger investigation");
          if (JSON.stringify(chainForRoute(config, route)) === JSON.stringify(chainForRoute(config, escalatedRoute)) && reasoningForRoute(config, route) === reasoningForRoute(config, escalatedRoute)) throw new Error("Trusted task settings provide no stronger escalation");
          difficulty = verified.escalation.difficulty;
          newContext = true;
        }
        previous = verified;
      }
    } catch (error) {
      failed = true;
      rejectStopped(error);
      await cancelAll();
      throw error;
    } finally { if (ownsSlot) release(); }
  });
  const settled = await Promise.allSettled(work);
  input.abortSignal?.removeEventListener("abort", onAbort);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return { complete: true, activeAxes: axes, assessments: settled.map(result => { if (result.status !== "fulfilled") throw new Error("Review work did not settle"); return result.value; }) };
}
