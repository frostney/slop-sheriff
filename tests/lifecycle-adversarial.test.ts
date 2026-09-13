import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import * as adapters from "../src/github/chat-adapter";
import { publishQueuedReviewNotices } from "../src/lifecycle/queued-status";
import { recoverInterruptedReview } from "../agent/lib/recover-interrupted-review";
import type { LifecycleJob } from "../src/lifecycle/contracts";

const modules = { "../convex/_generated/server.js": () => import("../convex/_generated/server.js"), "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle") };
const admission = (deliveryId = "old", eventTime = 1000) => ({ deliveryId, repository: "acme/repo", repositoryId: "R_1", pullRequest: 1, headSha: "head", eventTime, body: JSON.stringify({ action: "opened", installation: { id: 1 }, pull_request: { draft: false } }), event: "pull_request", signature: "" });

test("retirement waits for an overlapping Check creation and survives its late acknowledgement", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    await t.mutation(internal.reviewLifecycle.admit, admission());
    const [creating] = await t.mutation(internal.reviewLifecycle.claimQueueNotices, {});
    expect(creating?.cancelled).toBe(false);
    await t.mutation(internal.reviewLifecycle.admit, admission("new", 2000));
    // A cancellation lookup here would see no Check while the original create is still in flight.
    expect((await t.mutation(internal.reviewLifecycle.claimQueueNotices, {})).some(n => n.deliveryId === "old")).toBe(false);
    await t.mutation(internal.reviewLifecycle.finishQueueNotice, { deliveryId: "old", delivered: true, cancelled: false });
    clock.mockReturnValue(30_000);
    const retiring = (await t.mutation(internal.reviewLifecycle.claimQueueNotices, {})).find(n => n.deliveryId === "old");
    expect(retiring?.cancelled).toBe(true);
    await t.mutation(internal.reviewLifecycle.finishQueueNotice, { deliveryId: "old", delivered: true, cancelled: true });
    clock.mockReturnValue(2_000_000);
    expect((await t.mutation(internal.reviewLifecycle.claimQueueNotices, {})).some(n => n.deliveryId === "old")).toBe(false);
  } finally { clock.mockRestore(); }
});

test("terminal delivery recovery preserves the same report and attempt without claiming analysis", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(), body: "{}" });
  const [first] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  await t.mutation(internal.reviewLifecycle.activate, { attemptId: first!.attemptId, headSha: "head", sessionId: "completed-native" });
  const publication = '{"report":"already validated"}';
  await t.mutation(internal.reviewLifecycle.stage, { attemptId: first!.attemptId, kind: "report", publication });
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: first!.attemptId, outcome: "interrupted", failureCode: "publication_failed" });
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: first!.attemptId, prerequisiteReady: true, evidenceEligible: false })).toBe(true);
  expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
  const [retry] = await t.mutation(internal.reviewLifecycle.claimPublications, {});
  expect(retry).toMatchObject({ attemptId: first!.attemptId, publication, publicationKind: "report", sessionId: "completed-native" });
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: first!.attemptId, outcome: "delivered" });
  expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
});

test("a reused repository name cannot replace admitted identity through activation or stored context", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(), body: "{}" });
  const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  for (const supplied of [{ repositoryId: "R_REPLACEMENT" }, { trustedContext: JSON.stringify({ repositoryId: "R_REPLACEMENT", headSha: "head" }) }]) {
    expect(await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha: "head", ...supplied })).toBe(false);
  }
  const active = await t.query(internal.reviewLifecycle.inspect, { attemptId: job!.attemptId });
  expect(active).toMatchObject({ status: "dispatching", repositoryId: "R_1" });
  expect(active?.trustedContext).toBeUndefined();
});

async function withService(run: () => Promise<void>) {
  const original = { CONVEX_MEMORY_URL: process.env.CONVEX_MEMORY_URL, KNOWN_GOOD_REVIEW_MEMORY_TOKEN: process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN };
  Object.assign(process.env, { CONVEX_MEMORY_URL: "https://lifecycle.invalid", KNOWN_GOOD_REVIEW_MEMORY_TOKEN: "offline-token" });
  try { await run(); } finally {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test("queued publication checks live immutable identity before listing or mutating Checks", async () => withService(async () => {
  let checkRequests = 0;
  const adapter = spyOn(adapters, "githubAdapter").mockReturnValue({ octokit: {
    rest: { repos: { get: async () => ({ data: { node_id: "R_REPLACEMENT" } }) }, checks: { listForRef: () => { checkRequests++; } } },
    paginate: async () => { checkRequests++; return []; },
  } } as unknown as ReturnType<typeof adapters.githubAdapter>);
  const completed: unknown[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).endsWith("/claimQueueNotices")) return Response.json([{ ...admission(), installationId: 1, cancelled: false }]);
    completed.push(JSON.parse(String(init?.body))); return Response.json(null);
  }) as typeof fetch);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await publishQueuedReviewNotices();
    expect(checkRequests).toBe(0);
    expect(completed).toEqual([{ deliveryId: "old", delivered: false, cancelled: false }]);
  } finally { adapter.mockRestore(); fetchSpy.mockRestore(); errorLog.mockRestore(); }
}));

test("retained-report recovery probes GitHub only even when model credit is unavailable", async () => withService(async () => {
  const adapter = spyOn(adapters, "githubAdapter").mockReturnValue({ octokit: { rest: {
    repos: { get: async () => ({ data: { node_id: "R_1" } }) },
    pulls: { get: async () => ({ data: { state: "open", draft: false, head: { sha: "head" }, base: { sha: "base" } } }) },
  } } } as unknown as ReturnType<typeof adapters.githubAdapter>);
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: Parameters<typeof fetch>[0]) => {
    requests.push(String(url));
    if (String(url) !== "https://lifecycle.invalid/review-lifecycle/recover") throw new Error("Gateway is unavailable");
    return Response.json(true);
  }) as typeof fetch);
  try {
    const job: LifecycleJob = { ...admission(), attemptId: "attempt", sessionId: "completed-native", publicationKind: "report", publication: '{"report":"saved"}', interruption: JSON.stringify({ kind: "github-authentication", deployment: "current", credentialFingerprint: "key", recordedAt: 1000 }) };
    expect(await recoverInterruptedReview(job)).toBe(true);
    expect(requests).toEqual(["https://lifecycle.invalid/review-lifecycle/recover"]);
  } finally { adapter.mockRestore(); fetchSpy.mockRestore(); }
}));
