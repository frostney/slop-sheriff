import { expect, test } from "bun:test";
import { cancelDurableReview } from "../agent/lib/reconcile-review-worker";
import { lifecycleJobSchema } from "../src/lifecycle/contracts";
import type { Session } from "eve/channels";

const job = lifecycleJobSchema.parse({ deliveryId: "delivery", attemptId: "attempt", repository: "owner/repo", repositoryId: "R_repo", pullRequest: 1, headSha: "a".repeat(40), eventTime: 1, body: "{}", event: "pull_request", signature: "signature", sessionId: "root", workerSessionIds: ["retained-child"] });
function fixture() {
  const actions: string[] = [];
  const attachSession = (id: string): Session => ({ id,
    async cancel() { actions.push(`cancel:${id}`); return { status: "no_active_turn" }; },
    async reset() { actions.push(`reset:${id}`); return { status: "reset", previousSessionId: id }; },
    async send() { throw new Error("unused"); }, async respond() { throw new Error("unused"); }, async compact() { throw new Error("unused"); }, async clear() { throw new Error("unused"); }, async getEventStream() { throw new Error("unused"); }, async getStreamTailIndex() { throw new Error("unused"); },
  });
  return { actions, context: { attachSession, resolveSession: async () => undefined }, retireChecks: async () => { actions.push("retire-checks"); }, release: async () => { actions.push("release-capacity"); return null; } };
}
test("supersession drains unretained native descendants before releasing fair capacity", async () => {
  const f = fixture();
  await cancelDurableReview(job, f.context, { ...f, drain: async (root, retained, cancel) => {
    expect(root).toBe("root"); expect(retained).toEqual(["retained-child"]);
    expect(f.actions).toEqual(["cancel:root", "reset:root"]);
    await cancel("unretained-child");
    return { drained: true, runIds: [root,"unretained-child"], activeRunIds: [], activeStepIds: ["unretained-child:provider-call"] };
  } });
  expect(f.actions).toEqual(["cancel:root", "reset:root", "cancel:unretained-child", "reset:unretained-child", "retire-checks", "release-capacity"]);
});
test("native cancellation acknowledgements cannot release capacity before verified drain", async () => {
  const f = fixture();
  await expect(cancelDurableReview(job, f.context, { ...f, drain: async () => ({ drained: false, runIds: ["root","late-child"], activeRunIds: ["late-child"], activeStepIds: [] }) })).rejects.toThrow("scheduling fence");
  expect(f.actions).toEqual(["cancel:root", "reset:root"]);
});
test("native index failures retain the cancellation obligation for independent retry", async () => {
  const f = fixture();
  await expect(cancelDurableReview(job, f.context, { ...f, drain: async () => { throw new Error("native index unavailable"); } })).rejects.toThrow("native index unavailable");
  expect(f.actions).not.toContain("release-capacity");
});
