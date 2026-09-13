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

test("repeated failure staging reclaims displaced blobs and preserves the final report", async () => {
  const original = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "service-test-token";
  try {
    const t = convexTest(schema, modules);
    const post = async (data: unknown) => t.fetch("/review-lifecycle/stage", { method: "POST", headers: { authorization: "Bearer service-test-token", "content-type": "application/json" }, body: JSON.stringify(data) });
    await t.mutation(internal.reviewLifecycle.admit, { deliveryId: "blob-retry", repository: "acme/repo", repositoryId: "R_1", pullRequest: 1, headSha: "sha", eventTime: 1000, body: "{}", event: "pull_request", signature: "" });
    const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 1 });
    const attemptId = job!.attemptId;
    const pointers: string[] = [];
    for (const kind of ["failure", "failure", "report", "failure"] as const) {
      expect(await (await post({ attemptId, kind, publication: JSON.stringify({ kind, sequence: pointers.length }) })).json()).toBe(true);
      const row = await t.query(internal.reviewLifecycle.inspect, { attemptId });
      pointers.push((JSON.parse(row!.publication!) as { storageId: string }).storageId);
    }
    expect(pointers[0]).not.toBe(pointers[1]);
    expect(pointers[1]).not.toBe(pointers[2]);
    expect(pointers[2]).toBe(pointers[3]);
    const remaining = await t.run(ctx => ctx.db.system.query("_storage").collect());
    expect(remaining.map(row => String(row._id))).toEqual([pointers[2]!]);
  } finally {
    if (original === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
    else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = original;
  }
});
