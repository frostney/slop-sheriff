import type { Session, RouteHandlerArgs } from "eve/channels";
import { setTimeout as delay } from "node:timers/promises";
import type { TextSandbox } from "../../src/review/authenticated-evidence";
import type { LifecycleJob } from "../../src/lifecycle/contracts";
import { trustedGitHubContext, trustedGitHubContextSchema } from "../../src/github/trusted-context";
import { durableEvidenceReader } from "../../src/review/durable-evidence";
import { reviewWorkNativeHandleSchema, reviewWorkNativeHandlePath } from "./review-workflow";

/** Native dispatch starts the child before publishing subagent.called. Wait for
 * that exact receipt without invoking a model again or using an earlier turn's
 * handle. Cancellation interrupts both the snapshot request and the wait. */
export async function waitForNativeWorkInvocation(input: {
  rootSessionId: string; sessionId: string; invocationId: string;
  refresh: () => Promise<ReturnType<typeof reviewWorkNativeHandleSchema.parse>[]>;
  signal?: AbortSignal;
}) {
  for (;;) {
    input.signal?.throwIfAborted();
    const handles = await input.refresh();
    input.signal?.throwIfAborted();
    const handle = handles.find(handle => handle.rootSessionId === input.rootSessionId && handle.sessionId === input.sessionId && handle.invocationId === input.invocationId);
    if (handle) return handle;
    await delay(100, undefined, input.signal ? { signal: input.signal } : {});
  }
}

/** Snapshot the public durable stream only through its observed tail, never follow a live stream. */
export async function persistNativeWorkHandles(session: Pick<Session, "id" | "getStreamTailIndex" | "getEventStream">, reader: TextSandbox, patch: string) {
  const tail = await session.getStreamTailIndex();
  const handles = new Map<string, ReturnType<typeof reviewWorkNativeHandleSchema.parse>>();
  if (tail < 0) return [...handles.values()];
  const stream = (await session.getEventStream({ startIndex: 0 })).getReader();
  try {
    for (let index = 0; index <= tail; index++) {
      const next = await stream.read();
      if (next.done) throw new Error("Native stream ended before its recorded tail");
      const event = next.value;
      if (event.type !== "subagent.called" || !/:work:[a-f0-9]{64}:\d+$/.test(event.data.callId)) continue;
      if (event.data.sessionId !== session.id) throw new Error("Native work stream belongs to another root");
      const handle = reviewWorkNativeHandleSchema.parse({ rootSessionId: session.id, invocationId: event.data.callId, sessionId: event.data.childSessionId, agentId: event.data.agentId });
      handles.set(handle.sessionId, handle);
      const content = JSON.stringify(handle);
      await reader.writeTextFile({ path: reviewWorkNativeHandlePath(patch, handle.invocationId), content });
    }
  } finally { await stream.cancel(); stream.releaseLock(); }
  return [...handles.values()];
}
export async function captureReviewWorkHandles(job: LifecycleJob, rootSessionId: string, context: Pick<RouteHandlerArgs, "attachSession">) {
  if (job.sessionId !== rootSessionId || !job.trustedContext) throw new Error("Native work root is not admitted");
  const trusted = trustedGitHubContextSchema.parse(JSON.parse(job.trustedContext));
  if (trusted.deliveryId !== job.attemptId || !trusted.patchFingerprint) throw new Error("Native work attempt identity mismatch");
  return persistNativeWorkHandles(context.attachSession(rootSessionId), durableEvidenceReader(trusted, rootSessionId), trusted.patchFingerprint);
}
export async function refreshReviewWorkNativeHandles(auth: Parameters<typeof trustedGitHubContext>[0], rootSessionId: string, signal?: AbortSignal) {
  const trusted = trustedGitHubContext(auth);
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("Native work receipts require production origin");
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetch(`https://${host}/eve/v1/review-lifecycle`, { method: "POST", headers: { authorization: `Bearer ${process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN ?? ""}`, "x-review-operation": "work-handles", "x-review-attempt": trusted.deliveryId ?? "", "content-type": "application/json" }, body: JSON.stringify({ rootSessionId }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error("Native work receipt capture failed");
  return reviewWorkNativeHandleSchema.array().parse((await response.json() as { handles: unknown }).handles);
}
