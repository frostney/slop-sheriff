import { captureReviewWorkHandles } from "./native-work-handles";
import type { RouteHandlerArgs } from "eve/channels";
import { z } from "zod";
import type { LifecycleJob } from "../../src/lifecycle/contracts";
import { artifactRequest, durableEvidenceReader } from "../../src/review/durable-evidence";
import { trustedGitHubContextSchema } from "../../src/github/trusted-context";
import { reviewWorkCancellationPath, reviewWorkAdmissionSchema } from "./review-workflow";
import { drainNativeReviewDescendants } from "../../src/lifecycle/native-worker";

/** Cancels only signed native handles owned by this exact workflow invocation. */
export async function cancelReviewWork(job: LifecycleJob, raw: unknown, context: Pick<RouteHandlerArgs, "attachSession">): Promise<void> {
  const input = z.strictObject({ rootSessionId: z.string().min(1), invocationPrefix: z.string().min(1) }).parse(raw);
  if (!job.trustedContext || job.sessionId !== input.rootSessionId) throw new Error("Review cancellation root is not admitted");
  const trusted = trustedGitHubContextSchema.parse(JSON.parse(job.trustedContext));
  if (!trusted.patchFingerprint || trusted.deliveryId !== job.attemptId) throw new Error("Review cancellation attempt identity mismatch");
  const reader = durableEvidenceReader(trusted, input.rootSessionId);
  // Child turn admission writes its receipt before checking this durable fence.
  await reader.writeTextFile({ path: reviewWorkCancellationPath(trusted.patchFingerprint, input.invocationPrefix), content: JSON.stringify({ cancelled: true }) });
  await captureReviewWorkHandles(job, input.rootSessionId, context);
  let cursor: string | null = null;
  const sessions = new Set<string>();
  do {
    const page = z.object({ page: z.array(z.object({ path: z.string() })), isDone: z.boolean(), continueCursor: z.string() }).parse(await artifactRequest("list", { attemptId: job.attemptId, cursor }));
    for (const artifact of page.page) {
      if (!artifact.path.startsWith(`/tmp/known-good-review/work/${trusted.patchFingerprint}/admitted/`)) continue;
      const text = await reader.readTextFile({ path: artifact.path });
      if (text === null) throw new Error("Native work ownership artifact disappeared");
      const handle = reviewWorkAdmissionSchema.parse(JSON.parse(text));
      if (handle.rootSessionId === input.rootSessionId && handle.invocationId.startsWith(`${input.invocationPrefix}:work:`)) sessions.add(handle.sessionId);
    }
    if (!page.isDone && page.continueCursor === cursor) throw new Error("Native work cancellation pagination did not advance");
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  await Promise.all([...sessions].map(async sessionId => {
    const child = context.attachSession(sessionId);
    await child.cancel({ tasks: true });
    await child.reset({ reason: "Owning component workflow failed or was cancelled" });
    const drained = await drainNativeReviewDescendants(sessionId, [], async id => { await context.attachSession(id).cancel({ tasks: true }); });
    if (!drained.drained) throw new Error("Native component work cancellation has not fenced every descendant");
  }));
}
