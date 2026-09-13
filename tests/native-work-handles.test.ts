import { expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { persistNativeWorkHandles, waitForNativeWorkInvocation } from "../agent/lib/native-work-handles";
import { recordReviewWorkDispatch, admitNativeReviewWork, reviewWorkAdmissionPath, reviewWorkCancellationPath, reviewWorkNativeHandlePath, expectedNativeWorkInvocation } from "../agent/lib/review-workflow";
import { workOrchestrationFixture } from "./work-orchestration-fixture";
import type { Session } from "eve/channels";

type Stream = Awaited<ReturnType<Session["getEventStream"]>>;
type Event = Stream extends ReadableStream<infer E> ? E : never;
function called(id: string, child = "child"): Event {
  return { type: "subagent.called", data: { agentId: "native-agent", callId: id, childSessionId: child, childStreamPath: "/stream", sessionId: "root", sequence: 0, name: "agent", toolName: "agent", turnId: "turn_0", workflowId: "workflow" }, meta: { at: "2026-09-13T00:00:00.000Z", id: `event-${id}` } };
}
test("public native stream snapshot preserves exact invocation and latest child continuation", async () => {
  const f = workOrchestrationFixture(); const unit = f.plan.prepared.units[0]!;
  const first = `tool:workflow:work:${unit.id}:0`, next = `tool:workflow:work:${unit.id}:1`;
  const events = [called(first), called(next)];
  let options: unknown;
  const handles = await persistNativeWorkHandles({ id: "root", getStreamTailIndex: async () => 1, getEventStream: async input => { options = input; return simulateReadableStream({ chunks: events, initialDelayInMs: null, chunkDelayInMs: null }); } }, f.reader, f.plan.prepared.patchFingerprint);
  expect(options).toEqual({ startIndex: 0 });
  expect(handles).toHaveLength(1); expect(handles[0]!.invocationId).toBe(next);
  expect(f.files.has(reviewWorkNativeHandlePath(f.plan.prepared.patchFingerprint, first))).toBe(true);
  expect(f.files.has(reviewWorkNativeHandlePath(f.plan.prepared.patchFingerprint, next))).toBe(true);
});
test("snapshot stops at its observed tail and rejects mismatched native root", async () => {
  const f = workOrchestrationFixture(); const unit = f.plan.prepared.units[0]!; const event = called(`tool:run:work:${unit.id}:0`);
  let cancelled = false;
  const stream = new ReadableStream<Event>({ start(controller) { controller.enqueue(event); }, cancel() { cancelled = true; } });
  await persistNativeWorkHandles({ id: "root", getStreamTailIndex: async () => 0, getEventStream: async () => stream }, f.reader, f.plan.prepared.patchFingerprint);
  expect(cancelled).toBe(true);
  await expect(persistNativeWorkHandles({ id: "unrelated-root", getStreamTailIndex: async () => 0, getEventStream: async () => simulateReadableStream({ chunks: [event], initialDelayInMs: null, chunkDelayInMs: null }) }, f.reader, f.plan.prepared.patchFingerprint)).rejects.toThrow("another root");
});
test("child admission is either visible to cancellation or rejected before model execution", async () => {
  const f = workOrchestrationFixture(); const patch = f.plan.prepared.patchFingerprint; const unit = f.plan.prepared.units[0]!;
  const admission = { rootSessionId: "root", invocationId: `tool:run:work:${unit.id}:0`, sessionId: "child" };
  await recordReviewWorkDispatch(f.reader, patch, { rootSessionId: "root", invocationId: admission.invocationId, expectedSessionId: null });
  await admitNativeReviewWork(f.reader, patch, admission);
  expect(f.files.has(reviewWorkAdmissionPath(patch, "child"))).toBe(true);
  await f.reader.writeTextFile({ path: reviewWorkCancellationPath(patch, "tool:run"), content: JSON.stringify({ cancelled: true }) });
  await expect(admitNativeReviewWork(f.reader, patch, { ...admission, sessionId: "late-child" })).rejects.toThrow("cancelled before this child turn");
  expect(f.files.has(reviewWorkAdmissionPath(patch, "late-child"))).toBe(true);
});

test("lost native continuation handles cannot admit a fresh model context", async () => {
  const f = workOrchestrationFixture(); const patch = f.plan.prepared.patchFingerprint; const unit = f.plan.prepared.units[0]!;
  const invocationId = `tool:run:work:${unit.id}:1`;
  await recordReviewWorkDispatch(f.reader, patch, { rootSessionId: "root", invocationId, expectedSessionId: "existing-child" });
  await expect(admitNativeReviewWork(f.reader, patch, { rootSessionId: "root", invocationId, sessionId: "fallback-new-child" })).rejects.toThrow("unauthorized fresh child");
  expect(f.files.has(reviewWorkAdmissionPath(patch, "fallback-new-child"))).toBe(false);
});

test("child result waits for a late initial native event without substituting an unrelated receipt", async () => {
  const f = workOrchestrationFixture(); const patch = f.plan.prepared.patchFingerprint;
  const invocationId = `tool:run:work:${f.plan.prepared.units[0]!.id}:0`;
  await recordReviewWorkDispatch(f.reader, patch, { rootSessionId: "root", invocationId, expectedSessionId: null });
  expect(await expectedNativeWorkInvocation(f.reader, patch, { rootSessionId: "root", sessionId: "child", initialInvocationId: invocationId })).toBe(invocationId);
  let snapshots = 0;
  const receipt = await waitForNativeWorkInvocation({ rootSessionId: "root", sessionId: "child", invocationId,
    refresh: async () => {
      const events = ++snapshots === 1 ? [] : [called(invocationId, "other-child"), called(invocationId)];
      return persistNativeWorkHandles({ id: "root", getStreamTailIndex: async () => events.length - 1,
        getEventStream: async () => simulateReadableStream({ chunks: events, initialDelayInMs: null, chunkDelayInMs: null }) }, f.reader, patch);
    } });
  expect(snapshots).toBe(2); expect(receipt.sessionId).toBe("child"); expect(receipt.invocationId).toBe(invocationId);
});

test("continuation result waits for its app-issued invocation while native lineage and first snapshot are old", async () => {
  const f = workOrchestrationFixture(); const patch = f.plan.prepared.patchFingerprint;
  const first = `tool:run:work:${f.plan.prepared.units[0]!.id}:0`, next = first.replace(/:0$/, ":1");
  await recordReviewWorkDispatch(f.reader, patch, { rootSessionId: "root", invocationId: next, expectedSessionId: "child" });
  const invocationId = await expectedNativeWorkInvocation(f.reader, patch, { rootSessionId: "root", sessionId: "child", initialInvocationId: first });
  expect(invocationId).toBe(next);
  let snapshots = 0;
  const receipt = await waitForNativeWorkInvocation({ rootSessionId: "root", sessionId: "child", invocationId,
    refresh: async () => {
      const events = ++snapshots === 1 ? [called(first)] : [called(first), called(next)];
      return persistNativeWorkHandles({ id: "root", getStreamTailIndex: async () => events.length - 1,
        getEventStream: async () => simulateReadableStream({ chunks: events, initialDelayInMs: null, chunkDelayInMs: null }) }, f.reader, patch);
    } });
  expect(snapshots).toBe(2); expect(receipt.invocationId).toBe(next);
  await expect(expectedNativeWorkInvocation(f.reader, patch, { rootSessionId: "wrong-root", sessionId: "child", initialInvocationId: first })).rejects.toThrow("another work assignment");
});

test("late receipt waits stop on cancellation and propagate infrastructure errors", async () => {
  const controller = new AbortController(); let snapshots = 0;
  await expect(waitForNativeWorkInvocation({ rootSessionId: "root", sessionId: "child", invocationId: "current",
    signal: controller.signal, refresh: async () => { snapshots++; controller.abort(new Error("review superseded")); return []; } })).rejects.toThrow("review superseded");
  expect(snapshots).toBe(1);
  await expect(waitForNativeWorkInvocation({ rootSessionId: "root", sessionId: "child", invocationId: "current",
    refresh: async () => { throw new Error("receipt store unavailable"); } })).rejects.toThrow("receipt store unavailable");
});
