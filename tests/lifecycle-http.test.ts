import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
const modules = { "../convex/_generated/server.js": () => import("../convex/_generated/server.js"), "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle"), "../convex/http.ts": () => import("../convex/http") };

test("authenticated lifecycle HTTP preserves identity fences and explicit fresh-policy recovery", async () => {
  const original = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "service-test-token";
  try {
    const t = convexTest(schema, modules);
    const post = async (operation: string, data: unknown) => t.fetch(`/review-lifecycle/${operation}`, { method: "POST", headers: { authorization: "Bearer service-test-token", "content-type": "application/json" }, body: JSON.stringify(data) });
    expect((await t.fetch("/review-lifecycle/admit", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post("admit", { deliveryId: "d", repository: "acme/repo", repositoryId: "R_1", pullRequest: 1, headSha: "sha", eventTime: 1000, body: "{}", event: "pull_request", signature: "" })).status).toBe(200);
    const jobs = await (await post("claim", { capacity: 4 })).json() as { attemptId: string }[];
    const attemptId = jobs[0]!.attemptId;
    expect(await (await post("activate", { attemptId, headSha: "sha", repositoryId: "R_reused_name" })).json()).toBe(false);
    expect(await (await post("activate", { attemptId, headSha: "sha", repositoryId: "R_1", sessionId: "root", trustedContext: JSON.stringify({ repositoryId: "R_1", headSha: "sha" }), recoveryAuth: "oldauth" })).json()).toBe(true);
    await post("finish", { attemptId, outcome: "interrupted", interruption: "{}" });
    expect(await (await post("recover", { attemptId, evidenceEligible: true, prerequisiteReady: true, discardPriorEvidence: true })).json()).toBe(true);
    const row = await t.run(ctx => ctx.db.query("reviewDeliveries").first());
    expect(row!.recoverySourceAttemptId).toBeUndefined();
    expect(row!.recoveryAuth).toBeUndefined();
    expect(row!.trustedContext).toBeUndefined();
    expect(await t.query(internal.reviewLifecycle.fence, { attemptId })).toBe(false);
  } finally {
    if (original === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
    else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = original;
  }
});
