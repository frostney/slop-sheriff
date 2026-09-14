import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { vCompletedWorkBinding } from "./reviewWorkTables";
import { evidenceWriteClaimIsCurrent, vEvidenceWriteClaim } from "./probeData";

/** Authorization follows the current durable PR owner, never a caller-supplied repository. */
async function admitted(ctx: Pick<QueryCtx, "db">, currentAttemptId: string) {
  const job = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", currentAttemptId)).unique();
  if (!job || !["dispatching", "running", "publishing"].includes(job.status)) return null;
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", job.repositoryId).eq("pullRequest", job.pullRequest)).unique();
  return owner?.deliveryId === job.deliveryId ? job : null;
}
export const put = internalMutation({
  args: { currentAttemptId: v.string(), binding: vCompletedWorkBinding, signature: v.string(), storageId: v.id("_storage"), byteLength: v.number(), writeClaim: v.optional(vEvidenceWriteClaim) },
  returns: v.union(v.literal("stored"), v.literal("duplicate"), v.literal("forbidden")),
  handler: async (ctx, args) => {
    const job = await admitted(ctx, args.currentAttemptId);
    const binding = args.binding;
    if (!job || binding.sourceAttemptId !== args.currentAttemptId || binding.repositoryId !== job.repositoryId || binding.pullRequest !== job.pullRequest) return "forbidden";
    if (!await evidenceWriteClaimIsCurrent(ctx, args.currentAttemptId, args.writeClaim)) return "forbidden";
    const previous = await ctx.db.query("completedReviewWork").withIndex("by_semantic_version", q => q.eq("binding.repositoryId", job.repositoryId).eq("binding.pullRequest", job.pullRequest).eq("binding.scopeKey", binding.scopeKey).eq("binding.inputDigest", binding.inputDigest).eq("binding.contentDigest", binding.contentDigest)).unique();
    if (previous) return "duplicate";
    // Primary inputs can stay stable while a supporting observation changes.
    // Retain every completed content version; none may overwrite another.
    await ctx.db.insert("completedReviewWork", { binding, signature: args.signature, storageId: args.storageId, byteLength: args.byteLength });
    return "stored";
  },
});
export const get = internalQuery({
  args: { currentAttemptId: v.string(), scopeKey: v.string(), inputDigest: v.string() },
  returns: v.union(v.object({ kind: v.literal("forbidden") }), v.object({ kind: v.literal("missing") }), v.object({ kind: v.literal("found"), binding: vCompletedWorkBinding, signature: v.string(), storageId: v.id("_storage"), byteLength: v.number() })),
  handler: async (ctx, args) => {
    const job = await admitted(ctx, args.currentAttemptId);
    if (!job) return { kind: "forbidden" } as const;
    const row = await ctx.db.query("completedReviewWork").withIndex("by_repositoryId_and_pullRequest_and_scopeKey_and_inputDigest", q => q.eq("binding.repositoryId", job.repositoryId).eq("binding.pullRequest", job.pullRequest).eq("binding.scopeKey", args.scopeKey).eq("binding.inputDigest", args.inputDigest)).order("desc").first();
    return row ? { kind: "found" as const, binding: row.binding, signature: row.signature, storageId: row.storageId, byteLength: row.byteLength } : { kind: "missing" as const };
  },
});

/** Latest completion is historical evidence, not a semantic validity claim. */
export const latest = internalQuery({
  args: { currentAttemptId: v.string(), scopeKey: v.string() },
  returns: v.union(v.object({ kind: v.literal("forbidden") }), v.object({ kind: v.literal("missing") }), v.object({ kind: v.literal("found"), binding: vCompletedWorkBinding, signature: v.string(), storageId: v.id("_storage"), byteLength: v.number() })),
  handler: async (ctx, args) => {
    const job = await admitted(ctx, args.currentAttemptId);
    if (!job) return { kind: "forbidden" } as const;
    const row = await ctx.db.query("completedReviewWork").withIndex("by_repositoryId_and_pullRequest_and_scopeKey", q => q.eq("binding.repositoryId", job.repositoryId).eq("binding.pullRequest", job.pullRequest).eq("binding.scopeKey", args.scopeKey)).order("desc").first();
    return row ? { kind: "found" as const, binding: row.binding, signature: row.signature, storageId: row.storageId, byteLength: row.byteLength } : { kind: "missing" as const };
  },
});
