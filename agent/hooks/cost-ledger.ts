import { defineHook, type HookContext } from "eve/hooks";
import { trustedGitHubContext, reviewContextAttributes } from "../../src/github/trusted-context";
import { costExecutionScope, flushDurableCosts } from "../lib/cost-ledger";
import { reviewRouteState } from "../lib/review-route";

function bindScope(ctx: HookContext, turnId: string, stepIndex: number): void {
  costExecutionScope.update(() => null);
  const auth = ctx.session.auth.current;
  // Every full/delta continuation remains part of the review, including control responses.
  if (!auth?.attributes[reviewContextAttributes.plan]) return;
  const plan: unknown = JSON.parse(String(auth.attributes[reviewContextAttributes.plan]));
  if (typeof plan !== "object" || plan === null || !("kind" in plan) || (plan.kind !== "full" && plan.kind !== "delta")) return;
  const trusted = trustedGitHubContext(auth);
  const route = reviewRouteState.get();
  costExecutionScope.update(() => ({
    repositoryId: trusted.repositoryId, repository: trusted.repository, pullRequest: trusted.pullRequest,
    headSha: trusted.headSha, attemptId: trusted.deliveryId ?? ctx.session.id, reviewKind: plan.kind as "full" | "delta",
    sessionId: ctx.session.id, turnId, stepIndex,
    phase: route?.role === "lane" ? `lane:${route.axis}` : route?.role ?? "coordination",
  }));
}
export default defineHook({
  events: {
    "turn.started": (event, ctx) => bindScope(ctx, event.data.turnId, -1),
    async "step.started"(event, ctx) {
      bindScope(ctx, event.data.turnId, event.data.stepIndex);
      await flushDurableCosts();
    },
    "turn.completed": flushDurableCosts,
    "turn.failed": flushDurableCosts,
    "turn.cancelled": flushDurableCosts,
    "session.failed": flushDurableCosts,
    "session.completed": flushDurableCosts,
  },
});
