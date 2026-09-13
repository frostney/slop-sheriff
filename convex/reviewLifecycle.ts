import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { lifecycleRetryDelay } from "../src/lifecycle/contracts";

const admission = { deliveryId: v.string(), repository: v.string(), repositoryId: v.string(), pullRequest: v.number(), headSha: v.string(), eventTime: v.number(), body: v.string(), event: v.string(), signature: v.string() };
const job = v.object({ ...admission, status: v.string(), failureCode: v.optional(v.string()), attemptId: v.string(), sessionId: v.optional(v.string()), continuationAddress: v.optional(v.string()), previousSessionId: v.optional(v.string()), workerSessionIds: v.optional(v.array(v.string())), trustedContext: v.optional(v.string()), recoveryAuth: v.optional(v.string()), interruption: v.optional(v.string()), publicationInterruption: v.optional(v.string()), recoverySourceAttemptId: v.optional(v.string()), publication: v.optional(v.string()), publicationKind: v.optional(v.union(v.literal("report"), v.literal("failure"))) });
const leaseMs = 15 * 60_000;
function projection(row: Doc<"reviewDeliveries">) {
  return { deliveryId: row.deliveryId, status: row.status, repository: row.repository, repositoryId: row.repositoryId, pullRequest: row.pullRequest, headSha: row.headSha, eventTime: row.eventTime, body: row.body, event: row.event, signature: row.signature, ...(row.failureCode ? { failureCode: row.failureCode } : {}), attemptId: row.attemptId!, ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.continuationAddress ? { continuationAddress: row.continuationAddress } : {}), ...(row.previousSessionId ? { previousSessionId: row.previousSessionId } : {}), ...(row.workerSessionIds ? { workerSessionIds: row.workerSessionIds } : {}), ...(row.trustedContext ? { trustedContext: row.trustedContext } : {}), ...(row.recoveryAuth ? { recoveryAuth: row.recoveryAuth } : {}), ...(row.interruption ? { interruption: row.interruption } : {}), ...(row.publicationInterruption ? { publicationInterruption: row.publicationInterruption } : {}), ...(row.recoverySourceAttemptId ? { recoverySourceAttemptId: row.recoverySourceAttemptId } : {}), ...(row.publication ? { publication: row.publication, publicationKind: row.publicationKind } : {}) };
}
async function wakeRepository(ctx: MutationCtx, repositoryId: string) {
  const row = await ctx.db.query("reviewRepositories").withIndex("by_repositoryId", q => q.eq("repositoryId", repositoryId)).unique();
  if (row) await ctx.db.patch(row._id, { queued: true });
  else await ctx.db.insert("reviewRepositories", { repositoryId, queued: true, lastStartedAt: 0 });
}
async function current(ctx: Pick<QueryCtx, "db">, attemptId: string) {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", attemptId)).unique();
  if (!row || ["superseded", "complete", "interrupted"].includes(row.status)) return null;
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", row.repositoryId).eq("pullRequest", row.pullRequest)).unique();
  return owner?.deliveryId === row.deliveryId ? row : null;
}
export const admit = internalMutation({ args: admission, returns: v.object({ duplicate: v.boolean() }), handler: async (ctx, args) => {
  if (await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", args.deliveryId)).unique()) return { duplicate: true };
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", args.repositoryId).eq("pullRequest", args.pullRequest)).unique();
  const previousOwned = owner ? await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", owner.deliveryId)).unique() : null;
  const ambiguousHead = args.event === "pull_request" && owner?.eventTime === args.eventTime && previousOwned?.headSha !== args.headSha;
  const obsolete = !!owner && args.eventTime < owner.eventTime;
  await ctx.db.insert("reviewDeliveries", { ...args, status: obsolete ? "superseded" : ambiguousHead ? "verifying" : "queued", leaseUntil: 0, nextAttemptAt: Date.now(), attempts: 0 });
  // Comment permission is checked by the native handler before activation. A comment cannot cancel an authorized review during admission.
  if (!obsolete && !ambiguousHead && args.event === "pull_request") {
    if (owner) {
      const previous = await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", owner.deliveryId)).unique();
      if (previous && !["complete", "interrupted"].includes(previous.status)) {
        await ctx.db.patch(previous._id, { status: "superseded" });
        const notice = await ctx.db.query("reviewQueueNotices").withIndex("by_deliveryId", q => q.eq("deliveryId", previous.deliveryId)).unique();
        if (notice) await ctx.db.patch(notice._id, { status: "retiring", nextAttemptAt: notice.status === "delivered" ? Date.now() : Math.max(notice.nextAttemptAt, Date.now()) });
      }
      await ctx.db.patch(owner._id, { deliveryId: args.deliveryId, eventTime: args.eventTime });
    } else await ctx.db.insert("reviewOwners", { repositoryId: args.repositoryId, pullRequest: args.pullRequest, deliveryId: args.deliveryId, eventTime: args.eventTime });
  }
  if (!obsolete && !ambiguousHead) {
    await wakeRepository(ctx, args.repositoryId);
    const raw = JSON.parse(args.body) as { installation?: { id?: number }; action?: string; pull_request?: { draft?: boolean } };
    if (args.event === "pull_request" && raw.installation?.id && raw.action !== "closed" && !raw.pull_request?.draft) {
      await ctx.db.insert("reviewQueueNotices", { deliveryId: args.deliveryId, repositoryId: args.repositoryId, repository: args.repository, pullRequest: args.pullRequest, headSha: args.headSha, installationId: raw.installation.id, status: "pending", nextAttemptAt: Date.now(), attempts: 0 });
    }
  }
  return { duplicate: false };
} });

export const claim = internalMutation({ args: { capacity: v.number() }, returns: v.array(job), handler: async (ctx, { capacity }) => {
  const now = Date.now();
  const active = (await Promise.all((["dispatching", "running"] as const).map(status => ctx.db.query("reviewDeliveries").withIndex("by_status_and_leaseUntil", q => q.eq("status", status)).take(capacity)))).flat();
  const cancelling = await ctx.db.query("reviewDeliveries").withIndex("by_status_and_leaseUntil", q => q.eq("status", "superseded").gt("leaseUntil", Date.now())).take(capacity);
  const available = Math.max(0, capacity - active.length - cancelling.length);
  const selected: ReturnType<typeof projection>[] = [];
  const occupied = new Set([...active, ...cancelling].map(row => row.repositoryId));
  const repositories = await ctx.db.query("reviewRepositories").withIndex("by_queued_and_lastStartedAt", q => q.eq("queued", true)).take(256);
  for (const repository of repositories) {
    if (selected.length >= available) break;
    if (occupied.has(repository.repositoryId)) continue;
    const row = await ctx.db.query("reviewDeliveries").withIndex("by_repositoryId_and_status_and_nextAttemptAt", q => q.eq("repositoryId", repository.repositoryId).eq("status", "queued").lte("nextAttemptAt", now)).first();
    if (!row) {
      const future = await ctx.db.query("reviewDeliveries").withIndex("by_repositoryId_and_status_and_nextAttemptAt", q => q.eq("repositoryId", repository.repositoryId).eq("status", "queued")).first();
      if (!future) await ctx.db.patch(repository._id, { queued: false });
      continue;
    }
    const notice = await ctx.db.query("reviewQueueNotices").withIndex("by_deliveryId", q => q.eq("deliveryId", row.deliveryId)).unique();
    if (notice?.status === "pending") continue;
    const attemptId = crypto.randomUUID();
    await ctx.db.insert("reviewAttempts", { attemptId, deliveryId: row.deliveryId, repositoryId: row.repositoryId, pullRequest: row.pullRequest, headSha: row.headSha, startedAt: now });
    await ctx.db.patch(row._id, { status: "dispatching", attemptId, leaseUntil: now + leaseMs, attempts: row.attempts + 1 });
    await ctx.db.patch(repository._id, { lastStartedAt: now });
    selected.push(projection({ ...row, attemptId }));
    occupied.add(row.repositoryId);
  }
  return selected;
} });

export const inspect = internalQuery({ args: { attemptId: v.string(), includeSuperseded: v.optional(v.boolean()) }, returns: v.union(job, v.null()), handler: async (ctx, { attemptId, includeSuperseded }) => {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", attemptId)).unique();
  return row && (includeSuperseded || !["complete", "superseded", "interrupted"].includes(row.status)) ? projection(row) : null;
} });
export const fence = internalQuery({ args: { attemptId: v.string() }, returns: v.boolean(), handler: async (ctx, { attemptId }) => !!await current(ctx, attemptId) });

export const activate = internalMutation({ args: { attemptId: v.string(), headSha: v.string(), repositoryId: v.optional(v.string()), sessionId: v.optional(v.string()), continuationAddress: v.optional(v.string()), previousSessionId: v.optional(v.string()), trustedContext: v.optional(v.string()), recoveryAuth: v.optional(v.string()) }, returns: v.boolean(), handler: async (ctx, args) => {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", args.attemptId)).unique();
  if (!row || row.status === "superseded" || row.status === "interrupted") return false;
  const suppliedContext = args.trustedContext ? JSON.parse(args.trustedContext) as { repositoryId?: string; headSha?: string; pullRequestNumber?: number } : null;
  if (args.repositoryId && args.repositoryId !== row.repositoryId || suppliedContext && (suppliedContext.repositoryId !== row.repositoryId || suppliedContext.headSha !== args.headSha)) return false;
  if (row.status === "publishing" || row.status === "complete") {
    if (args.sessionId) await ctx.db.patch(row._id, { sessionId: args.sessionId });
    return true;
  }
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", row.repositoryId).eq("pullRequest", row.pullRequest)).unique();
  if (row.headSha && row.headSha !== args.headSha || owner && owner.deliveryId !== row.deliveryId && owner.eventTime > row.eventTime) {
    await ctx.db.patch(row._id, { status: "superseded" }); return false;
  }
  if (owner && owner.deliveryId !== row.deliveryId) {
    const previous = await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", owner.deliveryId)).unique();
    if (previous && !["complete", "interrupted"].includes(previous.status)) await ctx.db.patch(previous._id, { status: "superseded" });
    await ctx.db.patch(owner._id, { deliveryId: row.deliveryId, eventTime: row.eventTime });
  } else if (!owner) await ctx.db.insert("reviewOwners", { repositoryId: row.repositoryId, pullRequest: row.pullRequest, deliveryId: row.deliveryId, eventTime: row.eventTime });
  await ctx.db.patch(row._id, { status: "running", headSha: args.headSha, leaseUntil: Date.now() + leaseMs, ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.continuationAddress ? { continuationAddress: args.continuationAddress } : {}), ...(args.previousSessionId ? { previousSessionId: args.previousSessionId } : {}), ...(args.trustedContext ? { trustedContext: args.trustedContext } : {}), ...(args.recoveryAuth ? { recoveryAuth: args.recoveryAuth } : {}) }); return true;
} });
export const heartbeat = internalMutation({ args: { attemptId: v.string(), sessionId: v.optional(v.string()), workerSessionId: v.optional(v.string()) }, returns: v.boolean(), handler: async (ctx, args) => {
  const row = await current(ctx, args.attemptId);
  if (!row) return false;
  if (row.status === "publishing" && args.workerSessionId) return true;
  await ctx.db.patch(row._id, { ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.workerSessionId ? { workerSessionIds: [...new Set([...(row.workerSessionIds ?? []), args.workerSessionId])] } : {}), leaseUntil: Date.now() + leaseMs }); return true;
} });
export const stage = internalMutation({ args: { attemptId: v.string(), publication: v.string(), kind: v.union(v.literal("report"), v.literal("failure")), interruption: v.optional(v.string()) }, returns: v.boolean(), handler: async (ctx, args) => {
  const row = await current(ctx, args.attemptId); if (!row) return false;
  // A late failure callback cannot replace a validated report awaiting delivery.
  if (row.publicationKind === "report") return true;
  await ctx.db.patch(row._id, { status: "publishing", publication: args.publication, publicationKind: args.kind, ...(args.interruption ? { interruption: args.interruption } : {}), nextAttemptAt: Date.now(), leaseUntil: 0 }); return true;
} });
export const claimPublications = internalMutation({ args: {}, returns: v.array(job), handler: async (ctx) => {
  const now = Date.now();
  const rows = await ctx.db.query("reviewDeliveries").withIndex("by_status_and_nextAttemptAt", q => q.eq("status", "publishing").lte("nextAttemptAt", now)).take(32);
  const result: ReturnType<typeof projection>[] = [];
  for (const row of rows) if (row.leaseUntil <= now && await current(ctx, row.attemptId!)) {
    const draining = await ctx.db.query("reviewDeliveries").withIndex("by_repositoryId_and_pullRequest_and_status_and_leaseUntil", q => q.eq("repositoryId", row.repositoryId).eq("pullRequest", row.pullRequest).eq("status", "superseded").gt("leaseUntil", now)).first();
    if (draining) continue;
    await ctx.db.patch(row._id, { leaseUntil: now + leaseMs, nextAttemptAt: now + leaseMs }); result.push(projection(row));
  }
  return result;
} });
export const finish = internalMutation({ args: { attemptId: v.string(), outcome: v.union(v.literal("complete"), v.literal("delivered"), v.literal("retry"), v.literal("interrupted")), failureCode: v.optional(v.string()), interruption: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", args.attemptId)).unique();
  if (!row || ["complete", "interrupted"].includes(row.status)) return null;
  if (row.status === "superseded") {
    if (row.publication) await ctx.db.patch(row._id, { leaseUntil: 0 });
    return null;
  }
  if (row.status === "publishing" && args.outcome === "complete") return null;
  const attempt = await ctx.db.query("reviewAttempts").withIndex("by_attemptId", q => q.eq("attemptId", args.attemptId)).unique();
  if (attempt && !(row.publication && args.outcome === "retry")) await ctx.db.patch(attempt._id, { endedAt: Date.now(), outcome: args.outcome });
  if (args.outcome === "retry") {
    const attempts = row.publication ? (row.publicationAttempts ?? 0) + 1 : row.attempts;
    await ctx.db.patch(row._id, { status: row.publication ? "publishing" : "queued", nextAttemptAt: Date.now() + lifecycleRetryDelay(attempts), leaseUntil: 0, failureCode: args.failureCode, ...(row.publication ? { publicationAttempts: attempts } : { attemptId: undefined }) });
    if (!row.publication) await wakeRepository(ctx, row.repositoryId);
  } else await ctx.db.patch(row._id, { status: args.outcome === "delivered" ? (row.publicationKind === "failure" ? "interrupted" : "complete") : args.outcome, leaseUntil: 0, failureCode: args.failureCode, ...(args.outcome === "delivered" ? { publicationInterruption: undefined } : {}), ...(args.interruption ? args.failureCode === "publication_failed" ? { publicationInterruption: args.interruption } : { interruption: args.interruption } : {}) });
  return null;
} });

export const claimReconciliation = internalMutation({ args: {}, returns: v.array(job), handler: async (ctx) => {
  const result: ReturnType<typeof projection>[] = [];
  for (const status of ["dispatching", "running"] as const) {
    const rows = await ctx.db.query("reviewDeliveries").withIndex("by_status_and_leaseUntil", q => q.eq("status", status).lte("leaseUntil", Date.now())).take(32);
    for (const row of rows) { await ctx.db.patch(row._id, { leaseUntil: Date.now() + leaseMs }); result.push(projection(row)); }
  }
  return result;
} });

export const claimCancellations = internalQuery({ args: {}, returns: v.array(job), handler: async (ctx) => {
  const rows = await ctx.db.query("reviewDeliveries").withIndex("by_status_and_leaseUntil", q => q.eq("status", "superseded").gt("leaseUntil", 0)).take(32);
  return rows.filter(row => row.attemptId && (!row.publication || row.leaseUntil <= Date.now())).map(projection);
} });
export const cancelled = internalMutation({ args: { attemptId: v.string() }, returns: v.null(), handler: async (ctx, { attemptId }) => {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", attemptId)).unique();
  if (row?.status === "superseded") await ctx.db.patch(row._id, { leaseUntil: 0 });
  const attempt = await ctx.db.query("reviewAttempts").withIndex("by_attemptId", q => q.eq("attemptId", attemptId)).unique();
  if (attempt) await ctx.db.patch(attempt._id, { endedAt: Date.now(), outcome: "superseded" });
  return null;
} });

const queueNotice = v.object({ deliveryId: v.string(), repositoryId: v.string(), repository: v.string(), pullRequest: v.number(), headSha: v.string(), installationId: v.number(), cancelled: v.boolean() });
export const claimQueueNotices = internalMutation({ args: {}, returns: v.array(queueNotice), handler: async (ctx) => {
  const rows = (await Promise.all((["pending", "retiring"] as const).map(status => ctx.db.query("reviewQueueNotices").withIndex("by_status_and_nextAttemptAt", q => q.eq("status", status).lte("nextAttemptAt", Date.now())).take(32)))).flat();
  const result: { deliveryId: string; repositoryId: string; repository: string; pullRequest: number; headSha: string; installationId: number; cancelled: boolean }[] = [];
  for (const row of rows) {
    const delivery = await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", row.deliveryId)).unique();
    if (row.status !== "retiring" && (!delivery || delivery.status !== "queued")) { await ctx.db.patch(row._id, { status: "delivered" }); continue; }
    await ctx.db.patch(row._id, { nextAttemptAt: Date.now() + leaseMs });
    result.push({ deliveryId: row.deliveryId, repositoryId: row.repositoryId, repository: row.repository, pullRequest: row.pullRequest, headSha: row.headSha, installationId: row.installationId, cancelled: row.status === "retiring" });
  }
  return result;
} });
export const finishQueueNotice = internalMutation({ args: { deliveryId: v.string(), delivered: v.boolean(), cancelled: v.optional(v.boolean()) }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.query("reviewQueueNotices").withIndex("by_deliveryId", q => q.eq("deliveryId", args.deliveryId)).unique();
  if (row && row.status !== "delivered") await ctx.db.patch(row._id, { status: args.delivered && (row.status !== "retiring" || args.cancelled) ? "delivered" : row.status, attempts: row.attempts + 1, nextAttemptAt: Date.now() + lifecycleRetryDelay(row.attempts + 1) });
  return null;
} });

export const claimInterruptions = internalMutation({ args: {}, returns: v.array(job), handler: async (ctx) => {
  const rows = await ctx.db.query("reviewDeliveries").withIndex("by_status_and_nextAttemptAt", q => q.eq("status", "interrupted").lte("nextAttemptAt", Date.now())).take(32);
  const result: ReturnType<typeof projection>[] = [];
  for (const row of rows) {
    await ctx.db.patch(row._id, { nextAttemptAt: Date.now() + 60_000 });
    if (row.attemptId && (row.interruption || row.publicationInterruption)) result.push(projection(row));
  }
  return result;
} });
export const recover = internalMutation({ args: { attemptId: v.string(), evidenceEligible: v.boolean(), prerequisiteReady: v.boolean(), discardPriorEvidence: v.optional(v.boolean()), progressDigest: v.optional(v.string()) }, returns: v.boolean(), handler: async (ctx, args) => {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", args.attemptId)).unique();
  if (!row || row.status !== "interrupted" || !args.prerequisiteReady || (row.sessionId && !args.evidenceEligible && row.publicationKind !== "report" && row.failureCode !== "publication_failed")) return false;
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", row.repositoryId).eq("pullRequest", row.pullRequest)).unique();
  if (owner?.deliveryId !== row.deliveryId) return false;
  if ((row.publicationKind === "report" || row.failureCode === "publication_failed") && row.publication) {
    await ctx.db.patch(row._id, { status: "publishing", nextAttemptAt: Date.now(), leaseUntil: 0 });
    return true;
  }
  if (args.progressDigest && row.lastRecoveryProgressDigest === args.progressDigest) return false;
  await ctx.db.patch(row._id, { ...(args.progressDigest ? { lastRecoveryProgressDigest: args.progressDigest } : {}), status: "queued", recoverySourceAttemptId: args.discardPriorEvidence ? undefined : row.attemptId, ...(args.discardPriorEvidence ? { recoveryAuth: undefined, trustedContext: undefined } : {}), attemptId: undefined, sessionId: undefined, workerSessionIds: undefined, publication: undefined, publicationKind: undefined, leaseUntil: 0, nextAttemptAt: Date.now() });
  await wakeRepository(ctx, row.repositoryId);
  return true;
} });

export const owner = internalQuery({ args: { repositoryId: v.string(), pullRequest: v.number() }, returns: v.union(job, v.null()), handler: async (ctx, args) => {
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", args.repositoryId).eq("pullRequest", args.pullRequest)).unique();
  const row = owner ? await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", owner.deliveryId)).unique() : null;
  return row?.attemptId ? projection(row) : null;
} });
export const stop = internalMutation({ args: { attemptId: v.string() }, returns: v.boolean(), handler: async (ctx, args) => {
  const row = await current(ctx, args.attemptId);
  if (!row) return false;
  await ctx.db.patch(row._id, { status: "superseded", failureCode: "maintainer_stopped", ...(row.sessionId && !row.leaseUntil ? { leaseUntil: Date.now() + leaseMs } : {}) });
  return true;
} });

export const claimHeadVerifications = internalMutation({ args: {}, returns: v.array(v.object(admission)), handler: async (ctx) => {
  const rows = await ctx.db.query("reviewDeliveries").withIndex("by_status_and_leaseUntil", q => q.eq("status", "verifying").lte("leaseUntil", Date.now())).take(32);
  for (const row of rows) await ctx.db.patch(row._id, { leaseUntil: Date.now() + leaseMs });
  return rows.map(row => ({ deliveryId: row.deliveryId, repository: row.repository, repositoryId: row.repositoryId, pullRequest: row.pullRequest, headSha: row.headSha, eventTime: row.eventTime, body: row.body, event: row.event, signature: row.signature }));
} });
export const verifyHead = internalMutation({ args: { deliveryId: v.string(), currentHead: v.union(v.string(), v.null()) }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", args.deliveryId)).unique();
  if (!row || row.status !== "verifying") return null;
  if (args.currentHead === null) { await ctx.db.patch(row._id, { leaseUntil: Date.now() + 60_000 }); return null; }
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", row.repositoryId).eq("pullRequest", row.pullRequest)).unique();
  if (row.headSha !== args.currentHead || (owner && owner.eventTime > row.eventTime)) { await ctx.db.patch(row._id, { status: "superseded", leaseUntil: 0 }); return null; }
  if (owner) {
    const previous = await ctx.db.query("reviewDeliveries").withIndex("by_deliveryId", q => q.eq("deliveryId", owner.deliveryId)).unique();
    if (previous && !["complete", "interrupted"].includes(previous.status)) {
      await ctx.db.patch(previous._id, { status: "superseded" });
      const notice = await ctx.db.query("reviewQueueNotices").withIndex("by_deliveryId", q => q.eq("deliveryId", previous.deliveryId)).unique();
      if (notice) await ctx.db.patch(notice._id, { status: "retiring", nextAttemptAt: notice.status === "delivered" ? Date.now() : Math.max(notice.nextAttemptAt, Date.now()) });
    }
    await ctx.db.patch(owner._id, { deliveryId: row.deliveryId, eventTime: row.eventTime });
  } else await ctx.db.insert("reviewOwners", { repositoryId: row.repositoryId, pullRequest: row.pullRequest, deliveryId: row.deliveryId, eventTime: row.eventTime });
  await ctx.db.patch(row._id, { status: "queued", leaseUntil: 0 });
  await wakeRepository(ctx, row.repositoryId);
  const raw = JSON.parse(row.body) as { installation?: { id?: number }; action?: string; pull_request?: { draft?: boolean } };
  if (raw.installation?.id && raw.action !== "closed" && !raw.pull_request?.draft) await ctx.db.insert("reviewQueueNotices", { deliveryId: row.deliveryId, repositoryId: row.repositoryId, repository: row.repository, pullRequest: row.pullRequest, headSha: row.headSha, installationId: raw.installation.id, status: "pending", nextAttemptAt: Date.now(), attempts: 0 });
  return null;
} });
