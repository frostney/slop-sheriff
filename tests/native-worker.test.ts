import { expect, test } from "bun:test";
import { reconcileNativeWorker } from "../src/lifecycle/native-worker";
import * as runtime from "../node_modules/eve/dist/src/compiled/@workflow/core/runtime.js";
import { WorkflowRunNotFoundError } from "../node_modules/eve/dist/src/compiled/@workflow/errors/index.js";

function nativeWorld(input: { status?: string; lookupFailure?: Error; failOnRead?: number; queueFailure?: Error }) {
  const reads: unknown[][] = [];
  const queued: unknown[][] = [];
  let created = 0;
  let eventsWritten = 0;
  let providerCalls = 0;
  const unexpected = () => { providerCalls += 1; throw new Error("Unexpected execution during reconciliation"); };
  const world = {
    specVersion: 7,
    runs: {
      get: async (...args: unknown[]) => {
        reads.push(args);
        if (input.lookupFailure && (input.failOnRead === undefined || input.failOnRead === reads.length)) throw input.lookupFailure;
        return { runId: "wrun-original", workflowName: "workflow//eve/agentWorkflow",
          status: input.status ?? "running", deploymentId: "dpl-original", specVersion: 7 };
      },
      create: async () => { created += 1; throw new Error("Cannot create a new run"); },
    },
    events: { create: async () => { eventsWritten += 1; throw new Error("Cannot interrupt persisted waits"); } },
    queue: async (...args: unknown[]) => {
      queued.push(args);
      if (input.queueFailure) throw input.queueFailure;
      return { messageId: "message-existing-run" };
    },
    invoke: unexpected,
  };
  return { world, reads, queued, mutations: () => ({ created, eventsWritten, providerCalls }) };
}

test.each(["pending", "running"])("native reconciliation re-enqueues the original %s run and deployment without creating work", async status => {
  const fixture = nativeWorld({ status });
  // Only the test injects a structural World at the installed package boundary.
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    expect(await reconcileNativeWorker("wrun-original", async () => runtime)).toEqual({ kind: "recovered" });
    expect(fixture.queued).toEqual([["__eve_wkf_workflow_workflow//eve/agentWorkflow", { runId: "wrun-original" }, { deploymentId: "dpl-original", specVersion: 7 }]]);
    expect(fixture.reads).toEqual(Array.from({ length: 3 }, () => ["wrun-original", { resolveData: "none" }]));
    expect(fixture.mutations()).toEqual({ created: 0, eventsWritten: 0, providerCalls: 0 });
  } finally { runtime.setWorld(undefined); }
});

test.each(["completed", "failed", "cancelled"])("native %s status is terminal and never re-enqueued", async status => {
  const fixture = nativeWorld({ status });
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    const result = await reconcileNativeWorker("wrun-original", async () => runtime);
    expect(result).toEqual(status === "completed" ? { kind: "completed" } : { kind: "failed", code: `native-run-${status}` });
    expect(fixture.queued).toEqual([]);
    expect(fixture.mutations()).toEqual({ created: 0, eventsWritten: 0, providerCalls: 0 });
  } finally { runtime.setWorld(undefined); }
});

test("only the installed missing-run error becomes missing; transient and auth failures remain errors", async () => {
  for (const error of [new WorkflowRunNotFoundError("wrun-original"), Object.assign(new Error("temporarily unavailable"), { status: 503 }), Object.assign(new Error("unauthorized"), { status: 401 }), new Error("run not found text is not a typed missing error")]) {
    const fixture = nativeWorld({ lookupFailure: error });
    runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
    try {
      if (WorkflowRunNotFoundError.is(error)) expect(await reconcileNativeWorker("wrun-original", async () => runtime)).toEqual({ kind: "missing", code: "native-run-missing" });
      else await expect(reconcileNativeWorker("wrun-original", async () => runtime)).rejects.toBe(error);
      expect(fixture.queued).toEqual([]);
      expect(fixture.mutations()).toEqual({ created: 0, eventsWritten: 0, providerCalls: 0 });
    } finally { runtime.setWorld(undefined); }
  }
});

test("native queue failure propagates without creating a fresh run or interrupting sleeps", async () => {
  const fixture = nativeWorld({ queueFailure: new Error("queue unavailable") });
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    await expect(reconcileNativeWorker("wrun-original", async () => runtime)).rejects.toThrow("queue unavailable");
    expect(fixture.queued).toHaveLength(1);
    expect(fixture.mutations()).toEqual({ created: 0, eventsWritten: 0, providerCalls: 0 });
  } finally { runtime.setWorld(undefined); }
});

test("lookup failure after successful existence check does not become a missing worker", async () => {
  const error = Object.assign(new Error("transient status lookup failure"), { status: 503 });
  const fixture = nativeWorld({ lookupFailure: error, failOnRead: 2 });
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    await expect(reconcileNativeWorker("wrun-original", async () => runtime)).rejects.toBe(error);
    expect(fixture.reads).toHaveLength(2);
    expect(fixture.queued).toEqual([]);
    expect(fixture.mutations()).toEqual({ created: 0, eventsWritten: 0, providerCalls: 0 });
  } finally { runtime.setWorld(undefined); }
});

import { drainNativeReviewDescendants } from "../src/lifecycle/native-worker";
import { buildSubagentRootAttributes } from "../node_modules/eve/dist/src/execution/eve-workflow-attributes.js";
function drainWorld(options: { cancelFailure?: boolean; listFailure?: boolean; runningStep?: boolean; ignoreCancel?: boolean; racingChild?: boolean } = {}) {
  const now = new Date("2026-09-13T00:00:00Z");
  const make = (runId: string, status: string, attributes: Record<string, string>) => ({ runId, status, attributes, specVersion: 7, deploymentId: "original-deployment", workflowName: "workflow//eve//workflowEntry", createdAt: now, updatedAt: now });
  // Actual Eve attribute builder seeds lineage before a child can reach its first hook.
  const childAttributes = Object.fromEntries(Object.entries(buildSubagentRootAttributes({ identity: { nodeId: "review-lane" }, parentSessionId: "root", rootSessionId: "root", serializedContext: {} })).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const rows = new Map([
    ["root", make("root", "failed", { "$eve.type": "session" })],
    ["unrelated", make("unrelated", "running", { "$eve.type": "session" })],
    ["pre-heartbeat-child", make("pre-heartbeat-child", "pending", childAttributes)],
    ["workflow-body", make("workflow-body", "running", { "$parentRunId": "pre-heartbeat-child", "$rootRunId": "root" })],
  ]);
  const cancelled: unknown[][] = [];
  const sessions: string[] = [];
  let scans = 0;
  const world = {
    specVersion: 7,
    runs: {
      get: async (id: string) => { const row = rows.get(id); if (!row) throw new WorkflowRunNotFoundError(id); return { ...row }; },
      list: async ({ pagination }: { pagination: { cursor?: string } }) => {
        if (options.listFailure) throw new Error("canonical list failed");
        if (!pagination.cursor) { scans += 1; if (scans === 2 && options.racingChild) rows.set("racing-child", make("racing-child", "pending", childAttributes)); }
        const offset = Number(pagination.cursor ?? "0");
        const all = [...rows.values()];
        return { data: all.slice(offset, offset + 2).map(row => ({ ...row })), hasMore: offset + 2 < all.length, cursor: offset + 2 < all.length ? String(offset + 2) : null };
      },
    },
    steps: { list: async ({ runId }: { runId: string }) => ({ data: runId === "workflow-body" ? [{ stepId: "provider", status: options.runningStep ? "running" : "pending" }] : [], hasMore: false, cursor: null }) },
    events: { create: async (...args: unknown[]) => {
      cancelled.push(args);
      if (options.cancelFailure) throw new Error("native cancel failed");
      if (!options.ignoreCancel) rows.get(String(args[0]))!.status = "cancelled";
      return {};
    } },
    queue: async () => { throw new Error("Drain must not enqueue provider work"); },
  };
  return { world, rows, cancelled, sessions, cancelSession: async (id: string) => { sessions.push(id); }, scans: () => scans };
}

test("native drain discovers paginated pre-heartbeat descendants, cancels exact runs and verifies fenced pending steps", async () => {
  const fixture = drainWorld();
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    const result = await drainNativeReviewDescendants("root", [], fixture.cancelSession, async () => runtime);
    expect(result).toEqual({ drained: true, runIds: ["root", "pre-heartbeat-child", "workflow-body"], activeRunIds: [], activeStepIds: [] });
    expect(fixture.sessions).toEqual(["pre-heartbeat-child"]);
    expect(fixture.cancelled.map(args => [args[0], (args[1] as { eventType: string; specVersion: number }).eventType, (args[1] as { specVersion: number }).specVersion])).toEqual([["pre-heartbeat-child", "run_cancelled", 7], ["workflow-body", "run_cancelled", 7]]);
    expect(fixture.rows.get("unrelated")!.status).toBe("running");
    expect(fixture.scans()).toBe(2);
  } finally { runtime.setWorld(undefined); }
});

test.each([{ ignoreCancel: true }, { racingChild: true }])("native drain does not trust acknowledgements or miss a cancellation-time child: %p", async options => {
  const fixture = drainWorld(options);
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    const result = await drainNativeReviewDescendants("root", [], fixture.cancelSession, async () => runtime);
    expect(result.drained).toBe(false);
    expect(result.activeRunIds.length + result.activeStepIds.length).toBeGreaterThan(0);
  } finally { runtime.setWorld(undefined); }
});

test.each([{ cancelFailure: true }, { listFailure: true }])("native descendant lookup or cancellation failures never authorize replacement: %p", async options => {
  const fixture = drainWorld(options);
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try { await expect(drainNativeReviewDescendants("root", [], fixture.cancelSession, async () => runtime)).rejects.toThrow(); }
  finally { runtime.setWorld(undefined); }
});

test("native drain refuses an unrelated retained worker and never cancels it", async () => {
  const fixture = drainWorld();
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    await expect(drainNativeReviewDescendants("root", ["unrelated"], fixture.cancelSession, async () => runtime)).rejects.toThrow("unverifiable lineage");
    expect(fixture.cancelled).toEqual([]);
  } finally { runtime.setWorld(undefined); }
});

test("native terminal fencing exposes lingering running steps without inventing physical HTTP completion", async () => {
  const fixture = drainWorld({ runningStep: true });
  runtime.setWorld(fixture.world as unknown as NonNullable<Parameters<typeof runtime.setWorld>[0]>);
  try {
    expect(await drainNativeReviewDescendants("root", [], fixture.cancelSession, async () => runtime)).toMatchObject({ drained: true, activeRunIds: [], activeStepIds: ["workflow-body:provider"] });
  } finally { runtime.setWorld(undefined); }
});
