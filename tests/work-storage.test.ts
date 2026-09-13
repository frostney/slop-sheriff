import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { authenticateCompletedReviewWork, completedReviewWorkStore, completedWorkDigest, signCompletedReviewWork } from "../src/review/work-storage";
import { completedWorkMaxBytes } from "../src/review/work-storage-contracts";

const modules = { "../convex/_generated/server.js": () => import("../convex/_generated/server.js"), "../convex/reviewWorkData.ts": () => import("../convex/reviewWorkData"), "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle"), "../convex/http.ts": () => import("../convex/http") };
const secret = "ab".repeat(32);
const scopeKey = completedWorkDigest("engineering:component");
const inputDigest = completedWorkDigest("dependencies and semantic policy");
const key = { scopeKey, inputDigest };
const admission = (repositoryId = "R_1", deliveryId = "delivery", eventTime = 1000) => ({ deliveryId, repository: `acme/${repositoryId}`, repositoryId, pullRequest: 1, headSha: `head-${eventTime}`, eventTime, body: "{}", event: "pull_request", signature: "" });

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.reviewLifecycle.admit, admission());
  const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  const context = { repositoryId: job!.repositoryId, pullRequest: job!.pullRequest, deliveryId: job!.attemptId };
  const post = (operation: string, data: unknown, auth = true) => t.fetch(`/review-work/${operation}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer storage-test-token" } : {}) }, body: JSON.stringify(data) });
  const request = async (operation: "put" | "get" | "latest", data: unknown) => {
    const response = await post(operation, data);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  return { t, job: job!, context, post, request };
}
async function authenticated(run: () => Promise<void>) {
  const old = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "storage-test-token";
  try { await run(); } finally { if (old === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN; else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = old; }
}

test("completed work persists before publication, survives failure and is reusable on a new head", () => authenticated(async () => {
  const { t, context, request, job } = await fixture();
  const store = completedReviewWorkStore(context, { secret, request });
  expect(await store.put({ ...key, data: "completed findings" })).toBe("stored");
  await t.mutation(internal.reviewLifecycle.stage, { attemptId: job.attemptId, publication: "report", kind: "report" });
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: job.attemptId, outcome: "retry" });
  expect((await store.get(key))?.data).toBe("completed findings");
  await t.mutation(internal.reviewLifecycle.finish, { attemptId: job.attemptId, outcome: "interrupted" });
  await t.mutation(internal.reviewLifecycle.admit, admission("R_1", "new-head", 2000));
  const [next] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  const newStore = completedReviewWorkStore({ ...context, deliveryId: next!.attemptId }, { secret, request });
  expect(await newStore.get(key)).toMatchObject({ data: "completed findings", sourceAttemptId: job.attemptId });
  expect(await newStore.get({ ...key, inputDigest: completedWorkDigest("changed dependency") })).toBeNull();
  expect(await newStore.latest({ scopeKey })).toMatchObject({ data: "completed findings", inputDigest });
}));

test("HTTP retries deduplicate identical versions and retain revised supporting evidence", () => authenticated(async () => {
  const { t, context, request, post } = await fixture();
  const store = completedReviewWorkStore(context, { secret, request });
  const results = [await store.put({ ...key, data: "complete" }), await store.put({ ...key, data: "complete" })];
  expect(results.sort()).toEqual(["duplicate", "stored"]);
  const conflict = await post("put", { currentAttemptId: context.deliveryId, envelope: signCompletedReviewWork(context, { ...key, data: "conflicting completion" }, secret) });
  expect(conflict.status).toBe(200);
  expect(await t.run(ctx => ctx.db.query("completedReviewWork").take(10))).toHaveLength(2);
  expect((await store.get(key))?.data).toBe("conflicting completion");
  expect(await store.put({ ...key, data: "complete" })).toBe("duplicate");
  expect((await store.get(key))?.data).toBe("conflicting completion");
}));

test("service HTTP rejects stale writers, forged repository binding and cross-repository reads", () => authenticated(async () => {
  const { t, context, request, post, job } = await fixture();
  const store = completedReviewWorkStore(context, { secret, request });
  await store.put({ ...key, data: "private analysis" });
  expect((await post("get", { currentAttemptId: context.deliveryId, ...key }, false)).status).toBe(401);
  const forged = signCompletedReviewWork({ ...context, repositoryId: "R_other" }, { ...key, data: "forged" }, secret);
  expect((await post("put", { currentAttemptId: context.deliveryId, envelope: forged })).status).toBe(403);
  expect((await post("get", { currentAttemptId: context.deliveryId, ...key, repositoryId: "R_other" })).status).toBe(400);
  await t.mutation(internal.reviewLifecycle.admit, admission("R_other", "other", 2000));
  const [other] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 4 });
  expect(await (await post("get", { currentAttemptId: other!.attemptId, ...key })).json()).toBeNull();
  await t.mutation(internal.reviewLifecycle.admit, admission("R_1", "superseding", 3000));
  expect((await post("get", { currentAttemptId: job.attemptId, ...key })).status).toBe(403);
  expect((await post("put", { currentAttemptId: job.attemptId, envelope: signCompletedReviewWork(context, { ...key, data: "late" }, secret) })).status).toBe(403);
}));

test("corrupt HTTP data and modified stored blobs cannot become completed evidence", () => authenticated(async () => {
  const { t, context, post, request } = await fixture();
  const envelope = signCompletedReviewWork(context, { ...key, data: "valid" }, secret);
  expect((await post("put", { currentAttemptId: context.deliveryId, envelope: { ...envelope, data: "corrupt" } })).status).toBe(400);
  expect((await post("put", { currentAttemptId: context.deliveryId, envelope: { ...envelope, data: "x".repeat(completedWorkMaxBytes + 1) } })).status).toBe(400);
  await completedReviewWorkStore(context, { secret, request }).put({ ...key, data: "valid" });
  await t.run(async ctx => {
    const record = (await ctx.db.query("completedReviewWork").first())!;
    const storageId = await ctx.storage.store(new Blob(["corrupted blob"]));
    await ctx.db.patch(record._id, { storageId });
  });
  expect((await post("get", { currentAttemptId: context.deliveryId, ...key })).status).toBe(503);
}));

test("application authentication binds original attempt, content, repository, semantic scope and input", () => {
  const context = { repositoryId: "R_1", pullRequest: 1, deliveryId: "old-attempt" };
  const envelope = signCompletedReviewWork(context, { ...key, data: "completed" }, secret);
  expect(authenticateCompletedReviewWork(envelope, { ...context, deliveryId: "new-attempt" }, key, secret).sourceAttemptId).toBe("old-attempt");
  for (const field of ["sourceAttemptId", "repositoryId", "scopeKey", "inputDigest", "contentDigest"] as const) {
    const corrupt = { ...envelope, binding: { ...envelope.binding, [field]: field.endsWith("Digest") || field === "scopeKey" ? "f".repeat(64) : "other" } };
    expect(() => authenticateCompletedReviewWork(corrupt, context, key, secret)).toThrow();
  }
  expect(() => authenticateCompletedReviewWork({ ...envelope, data: "altered", binding: { ...envelope.binding, contentDigest: completedWorkDigest("altered") } }, context, key, secret)).toThrow();
});


test("concurrent authoritative completion mutations admit one immutable result", () => authenticated(async () => {
  const { t, context } = await fixture();
  const envelope = signCompletedReviewWork(context, { ...key, data: "complete" }, secret);
  // convex-test cannot concurrently transact HTTP storage.store calls. Preallocate blobs,
  // then exercise the same actual mutation used by HTTP under simultaneous writers.
  const storageIds = await t.run(async ctx => [await ctx.storage.store(new Blob(["complete"])), await ctx.storage.store(new Blob(["complete"]))]);
  const results = await Promise.all(storageIds.map(storageId => t.mutation(internal.reviewWorkData.put, { currentAttemptId: context.deliveryId!, binding: envelope.binding, signature: envelope.signature, storageId, byteLength: 8 })));
  expect(results.sort()).toEqual(["duplicate", "stored"]);
  expect(await t.run(ctx => ctx.db.query("completedReviewWork").take(10))).toHaveLength(1);
}));

test("latest completion is only historical context and does not satisfy changed semantic inputs", () => authenticated(async () => {
  const { context, request } = await fixture();
  const store = completedReviewWorkStore(context, { secret, request });
  await store.put({ ...key, data: "old semantic result" });
  const changed = { scopeKey, inputDigest: completedWorkDigest("new source dependency") };
  await store.put({ ...changed, data: "new semantic result" });
  expect((await store.latest({ scopeKey }))?.inputDigest).toBe(changed.inputDigest);
  expect((await store.get(key))?.data).toBe("old semantic result");
  expect((await store.get(changed))?.data).toBe("new semantic result");
  expect(await store.get({ scopeKey, inputDigest: completedWorkDigest("unknown scope inputs") })).toBeNull();
}));

test("read adapter rejects a stored envelope with forged source provenance even when its content digest matches", () => authenticated(async () => {
  const { t, context, request } = await fixture();
  const store = completedReviewWorkStore(context, { secret, request });
  await store.put({ ...key, data: "completed" });
  await t.run(async ctx => {
    const row = (await ctx.db.query("completedReviewWork").first())!;
    await ctx.db.patch(row._id, { binding: { ...row.binding, sourceAttemptId: "forged-source-attempt" } });
  });
  await expect(store.get(key)).rejects.toThrow("authentication failed");
}));

test("concurrent different evidence versions are retained without replacing either completion", () => authenticated(async () => {
  const {t,context} = await fixture();
  const values = ["supporting source one", "supporting source two"];
  const envelopes = values.map(data=>signCompletedReviewWork(context,{...key,data},secret));
  const blobs = await t.run(async ctx=>[await ctx.storage.store(new Blob([values[0]!])),await ctx.storage.store(new Blob([values[1]!]))]);
  const results = await Promise.all(envelopes.map((envelope,index)=>t.mutation(internal.reviewWorkData.put,{currentAttemptId:context.deliveryId,binding:envelope.binding,signature:envelope.signature,storageId:blobs[index]!,byteLength:values[index]!.length})));
  expect(results).toEqual(["stored","stored"]);
  const rows = await t.run(ctx=>ctx.db.query("completedReviewWork").take(10));
  expect(rows.map(row=>row.binding.contentDigest).sort()).toEqual(values.map(completedWorkDigest).sort());
}));

test("unknown successful-write response retries idempotently without deleting the committed blob", () => authenticated(async () => {
  const {context,request} = await fixture(); let lost = true;
  const store = completedReviewWorkStore(context,{secret,request:async(operation,body)=>{
    const result = await request(operation,body);
    if (operation === "put" && lost) { lost=false; throw new Error("response lost after commit"); }
    return result;
  }});
  await expect(store.put({...key,data:"committed evidence"})).rejects.toThrow("response lost");
  expect(await store.put({...key,data:"committed evidence"})).toBe("duplicate");
  expect((await store.get(key))?.data).toBe("committed evidence");
}));
