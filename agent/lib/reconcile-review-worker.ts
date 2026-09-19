import { retireSupersededReviewChecks } from "../../src/lifecycle/queued-status";
import type { RouteHandlerArgs } from "eve/channels";
import type { LifecycleJob } from "../../src/lifecycle/contracts";
import { finishReview, heartbeatReview, lifecycleRequest, stageLifecyclePublication } from "../../src/lifecycle/client";
import { trustedGitHubContextSchema } from "../../src/github/trusted-context";
import { drainNativeReviewDescendants, reconcileNativeWorker } from "../../src/lifecycle/native-worker";

export async function cancelDurableReview(job: LifecycleJob, context: Pick<RouteHandlerArgs, "attachSession" | "resolveSession">, dependencies = {
  drain: drainNativeReviewDescendants,
  retireChecks: retireSupersededReviewChecks,
  release: (attemptId: string) => lifecycleRequest("cancelled", { attemptId }),
}): Promise<void> {
  const resolved = job.sessionId ? context.attachSession(job.sessionId) : job.continuationAddress ? await context.resolveSession(job.continuationAddress) : undefined;
  const session = resolved?.id === job.previousSessionId && !job.sessionId ? undefined : resolved;
  if (session) { await session.cancel({ tasks: true }); await session.reset({ reason: "review superseded" }); }
  if (session) {
    const drain = await dependencies.drain(session.id, job.workerSessionIds ?? [], async childId => {
      const child = context.attachSession(childId);
      await child.cancel({ tasks: true });
      await child.reset({ reason: "parent review superseded" });
    });
    if (!drain.drained) throw new Error("Superseded review descendants have not reached a native scheduling fence");
    console.log(JSON.stringify({ event: "known-good-review.supersession-drained", attemptId: job.attemptId, nativeRuns: drain.runIds, unresolvedInFlightSteps: drain.activeStepIds }));
  } else if (job.workerSessionIds?.length) throw new Error("Cannot release superseded review capacity without its native root identity");
  await dependencies.retireChecks(job);
  await dependencies.release(job.attemptId);
}
export async function reconcileDurableReview(job: LifecycleJob, context: Pick<RouteHandlerArgs, "attachSession" | "resolveSession">): Promise<void> {
  const resolved = job.sessionId ? context.attachSession(job.sessionId) : job.continuationAddress ? await context.resolveSession(job.continuationAddress) : undefined;
  const session = resolved?.id === job.previousSessionId && !job.sessionId ? undefined : resolved;
  if (!session) {
    // There is no admitted native session to repeat: retry only pre-model admission.
    await finishReview(job.attemptId, "retry", "session_admission_missing");
    return;
  }
  const results = await Promise.all([...new Set([session.id, ...(job.workerSessionIds ?? [])])].map(id => reconcileNativeWorker(id)));
  const root = results[0]!;
  if (root.kind === "active" || root.kind === "recovered") {
    await heartbeatReview({ deliveryId: job.attemptId }, session.id);
    return;
  }
  // A terminal native session without an outbox report cannot certify coverage.
  // Preserve its visible interruption; never turn it into a fresh paid attempt.
  if (job.trustedContext) {
    const trusted = trustedGitHubContextSchema.parse(JSON.parse(job.trustedContext));
    await stageLifecyclePublication(trusted, "failure", { context: trusted, message: "Review execution ended before a complete validated report was durably staged. The lifecycle reconciler recovered this interruption independently of the session callback. Repair the recorded failure before requesting a new review." });
  } else await finishReview(job.attemptId, "interrupted", "native_session_terminal");
}
