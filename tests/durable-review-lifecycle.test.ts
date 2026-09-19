import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { parseReviewAdmission } from "../src/lifecycle/contracts";

const modules = { "../convex/_generated/server.js": () => import("../convex/_generated/server.js"), "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle") };
const admission = (repository: number, delivery = `delivery-${repository}`, eventTime = 1000) => ({ deliveryId: delivery, repository: `acme/repo${repository}`, repositoryId: `R_${repository}`, pullRequest: 1, headSha: `sha${repository}`, eventTime, body: "{}", event: "pull_request", signature: "" });

test("duplicate delivery admission commits once; newer head and same-SHA replacement fence every old attempt", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission(1));
  expect(await t.mutation(internal.reviewLifecycle.admit, admission(1))).toEqual({ duplicate: true });
  const [first] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  expect(first).toBeDefined();
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: first!.attemptId })).toBe(true);
  await t.mutation(internal.reviewLifecycle.admit, admission(1, "same-sha-new-delivery", 2000));
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: first!.attemptId })).toBe(false);
  // A superseded native worker still occupies capacity until cancellation is acknowledged.
  expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
  await t.mutation(internal.reviewLifecycle.cancelled, { attemptId: first!.attemptId });
  const [next] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  expect(next!.attemptId).not.toBe(first!.attemptId);
  await t.mutation(internal.reviewLifecycle.admit, admission(1, "out-of-order-old-head", 500));
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: next!.attemptId })).toBe(true);
  expect(await t.mutation(internal.reviewLifecycle.stage, { attemptId: first!.attemptId, kind: "failure", publication: "{}" })).toBe(false);
});

test("30 repository burst respects capacity, gives every repository a turn before repeat service, and preserves retries", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(10_000);
  try {
    for (let repo = 0; repo < 30; repo++) {
      await t.mutation(internal.reviewLifecycle.admit, admission(repo));
      await t.mutation(internal.reviewLifecycle.admit, { ...admission(repo, `second-${repo}`), pullRequest: 2 });
    }
    const served: string[] = [];
    for (let round = 0; round < 8; round++) {
      const jobs = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
      expect(jobs.length).toBeLessThanOrEqual(4);
      expect(new Set(jobs.map(j => j.repositoryId)).size).toBe(jobs.length);
      for (const job of jobs) {
        served.push(job.repositoryId);
        await t.mutation(internal.reviewLifecycle.finish, { attemptId: job.attemptId, outcome: "complete" });
      }
      clock.mockReturnValue(11_000 + round * 1000);
    }
    expect(new Set(served.slice(0, 30)).size).toBe(30);
    expect(served).toHaveLength(32);
  } finally { clock.mockRestore(); }
});

test("expired root lease requires native reconciliation, child progress never starts a duplicate or replaces root identity", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    await t.mutation(internal.reviewLifecycle.admit, admission(1));
    const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
    await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha: job!.headSha, sessionId: "root-session", continuationAddress: "address" });
    clock.mockReturnValue(20 * 60_000);
    expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
    expect(await t.mutation(internal.reviewLifecycle.claimReconciliation, {})).toHaveLength(1);
    await t.mutation(internal.reviewLifecycle.heartbeat, { attemptId: job!.attemptId });
    expect(await t.query(internal.reviewLifecycle.inspect, { attemptId: job!.attemptId })).toMatchObject({ sessionId: "root-session" });
    expect(await t.mutation(internal.reviewLifecycle.claimReconciliation, {})).toHaveLength(0);
    expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
  } finally { clock.mockRestore(); }
});

test("publication survives GitHub outage and terminal callback, retries without another execution claim", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    await t.mutation(internal.reviewLifecycle.admit, admission(1));
    const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
    await t.mutation(internal.reviewLifecycle.stage, { attemptId: job!.attemptId, kind: "report", publication: '{"report":"validated"}' });
    await t.mutation(internal.reviewLifecycle.stage, { attemptId: job!.attemptId, kind: "failure", publication: '{"failure":"late callback"}' });
    await t.mutation(internal.reviewLifecycle.finish, { attemptId: job!.attemptId, outcome: "complete" });
    const [publication] = await t.mutation(internal.reviewLifecycle.claimPublications, {});
    expect(publication!.publication).toBe('{"report":"validated"}');
    expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toHaveLength(0);
    await t.mutation(internal.reviewLifecycle.finish, { attemptId: job!.attemptId, outcome: "retry", failureCode: "github_503" });
    clock.mockReturnValue(30_000);
    expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
    expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toHaveLength(1);
    await t.mutation(internal.reviewLifecycle.finish, { attemptId: job!.attemptId, outcome: "delivered" });
    expect(await t.query(internal.reviewLifecycle.inspect, { attemptId: job!.attemptId })).toBeNull();
  } finally { clock.mockRestore(); }
});

test("leased publication prefix does not starve later pending publications", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (let repo = 0; repo < 40; repo++) await t.mutation(internal.reviewLifecycle.admit, admission(repo));
    for (let round = 0; round < 10; round++) {
      for (const job of await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 }))
        await t.mutation(internal.reviewLifecycle.stage, { attemptId: job.attemptId, kind: "report", publication: "{}" });
    }
    expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toHaveLength(32);
    expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toHaveLength(8);
  } finally { clock.mockRestore(); }
});

test("immutable repository identities isolate ownership across rename and name reuse", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission(1));
  const [first] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(2), repository: admission(1).repository });
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: first!.attemptId })).toBe(true);
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(1, "renamed", 2000), repository: "acme/renamed" });
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: first!.attemptId })).toBe(false);
});

test("manual trigger parser shares native command syntax; Connect admission does not need an HMAC header", () => {
  const headers = new Headers({ "x-github-delivery": "connect-delivery", "x-github-event": "issue_comment" });
  const body = JSON.stringify({ action: "created", repository: { full_name: "acme/repo", node_id: "R_repo" }, issue: { number: 1, pull_request: {} }, comment: { body: "/slop-sheriff run full review", created_at: "2026-09-13T00:00:00Z" } });
  expect(parseReviewAdmission(body, headers)).toMatchObject({ deliveryId: "connect-delivery", signature: "" });
});

test("replacement publication waits for an already accepted superseded provider request to drain", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    await t.mutation(internal.reviewLifecycle.admit, admission(1));
    const [first] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
    await t.mutation(internal.reviewLifecycle.stage, { attemptId: first!.attemptId, kind: "report", publication: "{}" });
    await t.mutation(internal.reviewLifecycle.claimPublications, {});
    await t.mutation(internal.reviewLifecycle.admit, admission(1, "replacement", 2000));
    // Replacement cannot be admitted into execution while the old external write is unresolved.
    expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
    expect(await t.query(internal.reviewLifecycle.claimCancellations, {})).toHaveLength(0);
    await t.mutation(internal.reviewLifecycle.finish, { attemptId: first!.attemptId, outcome: "retry" });
    const [next] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
    expect(next).toBeDefined();
    await t.mutation(internal.reviewLifecycle.stage, { attemptId: next!.attemptId, kind: "report", publication: "{}" });
    expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("queued status is independently leased and retried before execution capacity is consumed", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    const body = JSON.stringify({ action: "opened", installation: { id: 1 }, pull_request: { draft: false } });
    await t.mutation(internal.reviewLifecycle.admit, { ...admission(1), body });
    expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
    expect(await t.mutation(internal.reviewLifecycle.claimQueueNotices, {})).toHaveLength(1);
    expect(await t.mutation(internal.reviewLifecycle.claimQueueNotices, {})).toHaveLength(0);
    await t.mutation(internal.reviewLifecycle.finishQueueNotice, { deliveryId: "delivery-1", delivered: false });
    clock.mockReturnValue(30_000);
    expect(await t.mutation(internal.reviewLifecycle.claimQueueNotices, {})).toHaveLength(1);
    await t.mutation(internal.reviewLifecycle.finishQueueNotice, { deliveryId: "delivery-1", delivered: true });
    expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(1);
    await t.mutation(internal.reviewLifecycle.admit, { ...admission(1, "new-head", 2000), body });
    const notices = await t.mutation(internal.reviewLifecycle.claimQueueNotices, {});
    expect(notices.some(notice => notice.deliveryId === "delivery-1" && notice.cancelled)).toBe(true);
  } finally { clock.mockRestore(); }
});

test("terminal recovery requires repaired prerequisite and progress, rotates execution identity, and fences late callbacks", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission(1));
  const [first] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  await t.mutation(internal.reviewLifecycle.activate, { attemptId: first!.attemptId, headSha: first!.headSha, sessionId: "old-terminal-root" });
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: first!.attemptId, outcome: "interrupted", interruption: JSON.stringify({ kind: "credit", deployment: "a", credentialFingerprint: "key", recordedAt: 1000 }) });
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: first!.attemptId, prerequisiteReady: false, evidenceEligible: true, progressDigest: "progress1" })).toBe(false);
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: first!.attemptId, prerequisiteReady: true, evidenceEligible: false, progressDigest: "progress1" })).toBe(false);
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: first!.attemptId, prerequisiteReady: true, evidenceEligible: true, progressDigest: "progress1" })).toBe(true);
  const [second] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  expect(second!.deliveryId).toBe(first!.deliveryId);
  expect(second!.attemptId).not.toBe(first!.attemptId);
  expect(second!.recoverySourceAttemptId).toBe(first!.attemptId);
  expect(await t.mutation(internal.reviewLifecycle.stage, { attemptId: first!.attemptId, kind: "failure", publication: "{}" })).toBe(false);
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: second!.attemptId, outcome: "interrupted" });
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: second!.attemptId, prerequisiteReady: true, evidenceEligible: true, progressDigest: "progress1" })).toBe(false);
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: second!.attemptId, prerequisiteReady: true, evidenceEligible: true, progressDigest: "progress2" })).toBe(true);
});

test("equal-second out-of-order heads cannot cancel the active current-head review", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(1, "new-head"), headSha: "new" });
  const [active] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(1, "late-old-head"), headSha: "old" });
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: active!.attemptId })).toBe(true);
  expect(await t.mutation(internal.reviewLifecycle.claimHeadVerifications, {})).toHaveLength(1);
  await t.mutation(internal.reviewLifecycle.verifyHead, { deliveryId: "late-old-head", currentHead: "new" });
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: active!.attemptId })).toBe(true);
  expect(await t.query(internal.reviewLifecycle.claimCancellations, {})).toHaveLength(0);
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(1, "actual-newer-head"), headSha: "newer" });
  await t.mutation(internal.reviewLifecycle.verifyHead, { deliveryId: "actual-newer-head", currentHead: null });
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: active!.attemptId })).toBe(true);
  await t.mutation(internal.reviewLifecycle.verifyHead, { deliveryId: "actual-newer-head", currentHead: "newer" });
  expect(await t.query(internal.reviewLifecycle.fence, { attemptId: active!.attemptId })).toBe(false);
});

test("publication prerequisite repair retries retained report under its original attempt without execution", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission(1));
  const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha: job!.headSha, sessionId: "completed-native" });
  await t.mutation(internal.reviewLifecycle.stage, { attemptId: job!.attemptId, kind: "report", publication: "validated-report" });
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: job!.attemptId, outcome: "interrupted", failureCode: "github_403" });
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: job!.attemptId, evidenceEligible: false, prerequisiteReady: true })).toBe(true);
  expect(await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 })).toHaveLength(0);
  expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toMatchObject([{ attemptId: job!.attemptId, publication: "validated-report" }]);
});

test("a late queued Check creation acknowledgement preserves newer retirement intent", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, { ...admission(1), body: '{"installation":{"id":1}}' });
  const [notice] = await t.mutation(internal.reviewLifecycle.claimQueueNotices, {});
  await t.mutation(internal.reviewLifecycle.admit, admission(1, "replacement", 2000));
  await t.mutation(internal.reviewLifecycle.finishQueueNotice, { deliveryId: notice!.deliveryId, delivered: true, cancelled: false });
  const stored = await t.run(ctx => ctx.db.query("reviewQueueNotices").first());
  expect(stored!.status).toBe("retiring");
});

test("live repository name reuse cannot activate a different immutable repository identity", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission(1));
  const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  expect(await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha: job!.headSha, repositoryId: "R_replacement" })).toBe(false);
  expect(await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha: job!.headSha, trustedContext: JSON.stringify({ repositoryId: "R_replacement", headSha: job!.headSha }) })).toBe(false);
});

test("failure Check delivery retries preserve both model prerequisite and delivery prerequisite", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission(1));
  const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha: job!.headSha, sessionId: "terminal-native" });
  await t.mutation(internal.reviewLifecycle.stage, { attemptId: job!.attemptId, kind: "failure", publication: "failure-check", interruption: "key-budget" });
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: job!.attemptId, outcome: "interrupted", failureCode: "publication_failed", interruption: "github-authentication" });
  expect(await t.query(internal.reviewLifecycle.inspect, { attemptId: job!.attemptId, includeSuperseded: true })).toMatchObject({ interruption: "key-budget", publicationInterruption: "github-authentication" });
  expect(await t.mutation(internal.reviewLifecycle.recover, { attemptId: job!.attemptId, evidenceEligible: false, prerequisiteReady: true })).toBe(true);
  expect(await t.mutation(internal.reviewLifecycle.claimPublications, {})).toMatchObject([{ attemptId: job!.attemptId, publication: "failure-check" }]);
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: job!.attemptId, outcome: "delivered" });
  const terminal = await t.query(internal.reviewLifecycle.inspect, { attemptId: job!.attemptId, includeSuperseded: true });
  expect(terminal!.interruption).toBe("key-budget");
  expect(terminal!.publicationInterruption).toBeUndefined();
});
