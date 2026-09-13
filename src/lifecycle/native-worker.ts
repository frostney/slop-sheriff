export type NativeWorkerState = {
  readonly kind: "active" | "recovered" | "completed" | "failed" | "missing";
  readonly code?: string;
};

type NativeRuntime = Pick<typeof import("workflow/api"), "getRun" | "getWorld" | "reenqueueRun">;

/** Reconcile an explicitly retained session/run ID; never create a replacement run. */
export async function reconcileNativeWorker(
  sessionId: string,
  loadRuntime: () => Promise<NativeRuntime> = () => import("workflow/api"),
): Promise<NativeWorkerState> {
  if (!sessionId) throw new Error("Native worker reconciliation requires a session ID");
  const runtime = await loadRuntime();
  const run = runtime.getRun(sessionId);
  // Native exists handles only WorkflowRunNotFoundError. Network, authorization,
  // corruption and other lookup failures propagate instead of authorizing a retry.
  if (!await run.exists) return { kind: "missing", code: "native-run-missing" };
  const status = await run.status;
  if (status === "completed") return { kind: "completed" };
  if (status === "failed" || status === "cancelled") {
    return { kind: "failed", code: `native-run-${status}` };
  }
  if (status !== "pending" && status !== "running") throw new Error("Unsupported native worker status");
  // This preserves the stored run ID, deployment and spec version. Unlike wakeUp,
  // re-enqueue does not interrupt sleep() or mutate persisted waits and history.
  await runtime.reenqueueRun(await runtime.getWorld(), sessionId, { namespace: "eve" });
  return { kind: "recovered" };
}

export interface NativeDescendantDrain {
  readonly drained: boolean;
  readonly runIds: readonly string[];
  readonly activeRunIds: readonly string[];
  readonly activeStepIds: readonly string[];
}
type DrainRuntime = Pick<typeof import("workflow/api"), "getWorld" | "cancelRun">;

/** Rare terminal recovery only: canonical storage enumeration, never analytics or heartbeat completeness. */
export async function drainNativeReviewDescendants(
  rootSessionId: string,
  retainedSessionIds: readonly string[],
  cancelSession: (sessionId: string) => Promise<void>,
  loadRuntime: () => Promise<DrainRuntime> = () => import("workflow/api"),
): Promise<NativeDescendantDrain> {
  if (!rootSessionId) throw new Error("Descendant drain requires the original root session");
  const runtime = await loadRuntime();
  const world = await runtime.getWorld();
  type Run = Awaited<ReturnType<typeof world.runs.get>>;
  const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
  const root = await world.runs.get(rootSessionId, { resolveData: "none" });
  if (!terminal(root.status)) return { drained: false, runIds: [rootSessionId], activeRunIds: [rootSessionId], activeStepIds: [] };
  if ((root.specVersion ?? 1) < 4) throw new Error("Native review lineage requires workflow attribute support");
  const scan = async () => {
    const runs = new Map<string, Run>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await world.runs.list({ resolveData: "none", pagination: { limit: 100, sortOrder: "asc", ...(cursor ? { cursor } : {}) } });
      if (page.pageInfo) throw new Error("Canonical descendant enumeration unexpectedly has a retention window");
      for (const run of page.data) runs.set(run.runId, run);
      if (page.hasMore && (!page.cursor || cursors.has(page.cursor))) throw new Error("Native descendant pagination did not advance");
      cursor = page.hasMore ? page.cursor! : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!runs.has(rootSessionId)) throw new Error("Canonical descendant enumeration omitted the known root");
    const owned = new Set([rootSessionId]);
    let changed: boolean;
    do {
      changed = false;
      for (const run of runs.values()) {
        const attributes = run.attributes;
        if (!owned.has(run.runId) && [attributes["$eve.root"], attributes["$eve.parent"], attributes["$rootRunId"], attributes["$parentRunId"]].some(parent => parent !== undefined && owned.has(parent))) {
          owned.add(run.runId); changed = true;
        }
      }
    } while (changed);
    for (const id of retainedSessionIds) {
      const run = runs.get(id);
      if (!run || !owned.has(id)) throw new Error("Retained native child is absent or has unverifiable lineage");
    }
    return [...owned].map(id => runs.get(id)!);
  };
  const initial = await scan();
  // Session cancellation propagates signals to running model streams. Its acknowledgement
  // is not used as proof: exact native run and step records are re-read below.
  for (const run of initial) if (!terminal(run.status) && ["session", "subagent"].includes(run.attributes["$eve.type"] ?? "")) await cancelSession(run.runId);
  for (const run of initial) {
    const current = await world.runs.get(run.runId, { resolveData: "none" });
    if (!terminal(current.status)) await runtime.cancelRun(world, run.runId, { cancelReason: "Original review root is terminal; fence descendants before evidence recovery" });
  }
  // A child can be created while its parent is receiving cancellation. A new scan must
  // include it; pending/running discoveries defer replacement to a later recovery pass.
  const final = await scan();
  const activeRunIds: string[] = [];
  const activeStepIds: string[] = [];
  for (const run of final) {
    const current = await world.runs.get(run.runId, { resolveData: "none" });
    if (!terminal(current.status)) activeRunIds.push(run.runId);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await world.steps.list({ runId: run.runId, resolveData: "none", pagination: { limit: 100, ...(cursor ? { cursor } : {}) } });
      if (page.pageInfo) throw new Error("Canonical step enumeration unexpectedly has a retention window");
      // Terminal runs reject new step_started events; pending steps are fenced.
      for (const step of page.data) if (step.status === "running") activeStepIds.push(`${run.runId}:${step.stepId}`);
      if (page.hasMore && (!page.cursor || cursors.has(page.cursor))) throw new Error("Native step pagination did not advance");
      cursor = page.hasMore ? page.cursor! : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  // "drained" is a native scheduling fence, not proof that an already-running HTTP
  // request has stopped. Running-step metadata may outlive its executor; retain it
  // explicitly for accounting instead of inventing a lease timeout or terminal event.
  return { drained: activeRunIds.length === 0, runIds: final.map(run => run.runId), activeRunIds, activeStepIds };
}
