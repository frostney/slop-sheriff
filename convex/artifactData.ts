import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { vArtifactBinding } from "./artifactTables";
const vMetadata = v.object({ binding: vArtifactBinding, rootScope: v.string(), signedBinding: v.string(), recoverySourceAttemptId: v.optional(v.string()) });
const vArtifact = v.object({ ...vMetadata.fields, path: v.string(), storageId: v.id("_storage") });

export const put = internalMutation({
  args: { binding: vArtifactBinding, rootScope: v.string(), signedBinding: v.string(), path: v.string(), storageId: v.id("_storage"), digest: v.string(), revision: v.optional(v.number()) },
  returns: v.boolean(), handler: async (ctx, args) => {
    const job = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", args.binding.attemptId)).unique();
    if (!job || !["running", "dispatching", "publishing"].includes(job.status) || job.repositoryId !== args.binding.repositoryId || job.headSha !== args.binding.headSha || job.pullRequest !== args.binding.pullRequest) throw new Error("Evidence attempt no longer owns this review");
    const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", job.repositoryId).eq("pullRequest", job.pullRequest)).unique();
    if (owner?.deliveryId !== job.deliveryId) throw new Error("Evidence attempt no longer owns this review");
    const set = await ctx.db.query("reviewArtifactSets").withIndex("by_attemptId", q => q.eq("binding.attemptId", args.binding.attemptId)).unique();
    if (set && (set.signedBinding !== args.signedBinding || set.rootScope !== args.rootScope)) throw new Error("Evidence attempt binding is immutable");
    if (!set) await ctx.db.insert("reviewArtifactSets", { binding: args.binding, rootScope: args.rootScope, signedBinding: args.signedBinding, ...(job.recoverySourceAttemptId ? { recoverySourceAttemptId: job.recoverySourceAttemptId } : {}) });
    const previous = await ctx.db.query("reviewArtifacts").withIndex("by_attemptId_and_path", q => q.eq("attemptId", args.binding.attemptId).eq("path", args.path)).unique();
    if (previous?.digest === args.digest) return false;
    if (previous?.revision !== undefined && (args.revision === undefined || args.revision <= previous.revision)) throw new Error("Evidence checkpoint revision is stale or conflicting");
    const next = { attemptId: args.binding.attemptId, path: args.path, storageId: args.storageId, digest: args.digest, ...(args.revision !== undefined ? { revision: args.revision } : {}) };
    if (previous) {
      await ctx.db.replace(previous._id, next);
      await ctx.storage.delete(previous.storageId);
    } else await ctx.db.insert("reviewArtifacts", next);
    return true;
  },
});
export const get = internalQuery({ args: { attemptId: v.string(), path: v.string() }, returns: v.union(vArtifact, v.null()), handler: async (ctx, args) => {
  const set = await ctx.db.query("reviewArtifactSets").withIndex("by_attemptId", q => q.eq("binding.attemptId", args.attemptId)).unique();
  const artifact = await ctx.db.query("reviewArtifacts").withIndex("by_attemptId_and_path", q => q.eq("attemptId", args.attemptId).eq("path", args.path)).unique();
  return set && artifact ? { binding: set.binding, rootScope: set.rootScope, signedBinding: set.signedBinding, path: artifact.path, storageId: artifact.storageId, ...(set.recoverySourceAttemptId ? { recoverySourceAttemptId: set.recoverySourceAttemptId } : {}) } : null;
} });
export const list = internalQuery({ args: { attemptId: v.string(), paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(v.object({ path: v.string() })), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  const result = await ctx.db.query("reviewArtifacts").withIndex("by_attemptId_and_path", q => q.eq("attemptId", args.attemptId)).paginate(args.paginationOpts);
  return { page: result.page.map(row => ({ path: row.path })), isDone: result.isDone, continueCursor: result.continueCursor };
} });

export const metadata = internalQuery({ args: { attemptId: v.string() }, returns: v.union(vMetadata, v.null()), handler: async (ctx, { attemptId }) => {
  const row = await ctx.db.query("reviewArtifactSets").withIndex("by_attemptId", q => q.eq("binding.attemptId", attemptId)).unique();
  return row ? { binding: row.binding, rootScope: row.rootScope, signedBinding: row.signedBinding, ...(row.recoverySourceAttemptId ? { recoverySourceAttemptId: row.recoverySourceAttemptId } : {}) } : null;
} });
