import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";

const args = { attemptId: v.string(), path: v.string(), owner: v.string() };
export const vEvidenceWriteClaim = v.object({ path: v.string(), owner: v.string() });

/** Called in the same transaction as the write, so release fences delayed HTTP requests. */
export async function evidenceWriteClaimIsCurrent(ctx: Pick<QueryCtx, "db">, attemptId: string, writeClaim: { path: string; owner: string } | undefined): Promise<boolean> {
  if (!writeClaim) return true; // Application writes outside evidence locks retain admission checks.
  const claim = await ctx.db.query("reviewProbeClaims").withIndex("by_attemptId_and_path", q => q.eq("attemptId", attemptId).eq("path", writeClaim.path)).unique();
  return claim?.owner === writeClaim.owner && claim.status === "running";
}

async function assertCurrentAttempt(ctx: QueryCtx, attemptId: string): Promise<void> {
  const job = await ctx.db.query("reviewDeliveries").withIndex("by_attemptId", q => q.eq("attemptId", attemptId)).unique();
  if (!job || !["running", "dispatching"].includes(job.status)) throw new Error("Probe attempt no longer owns this review");
  const owner = await ctx.db.query("reviewOwners").withIndex("by_repositoryId_and_pullRequest", q => q.eq("repositoryId", job.repositoryId).eq("pullRequest", job.pullRequest)).unique();
  if (owner?.deliveryId !== job.deliveryId) throw new Error("Probe attempt no longer owns this review");
}

// Convex serializes competing mutations. A claim is never stolen on a timer:
// lifecycle recovery fences old workers and assigns a different attempt id.
export const claim = internalMutation({
  args, returns: v.object({ acquired: v.boolean(), owner: v.string() }),
  handler: async (ctx, input) => {
    await assertCurrentAttempt(ctx, input.attemptId);
    const previous = await ctx.db.query("reviewProbeClaims").withIndex("by_attemptId_and_path", q => q.eq("attemptId", input.attemptId).eq("path", input.path)).unique();
    if (previous && previous.status !== "released") return { acquired: false, owner: previous.owner };
    const next = { ...input, status: "running" as const };
    if (previous) await ctx.db.replace(previous._id, next);
    else await ctx.db.insert("reviewProbeClaims", next);
    return { acquired: true, owner: input.owner };
  },
});

export const release = internalMutation({
  args, returns: v.null(), handler: async (ctx, input) => {
    await assertCurrentAttempt(ctx, input.attemptId);
    const claim = await ctx.db.query("reviewProbeClaims").withIndex("by_attemptId_and_path", q => q.eq("attemptId", input.attemptId).eq("path", input.path)).unique();
    if (!claim || claim.owner !== input.owner) throw new Error("Probe claim belongs to another execution");
    await ctx.db.patch(claim._id, { status: "released" });
    return null;
  },
});

export const assertCurrent = internalQuery({
  args: { attemptId: v.string() }, returns: v.null(), handler: async (ctx, { attemptId }) => {
    await assertCurrentAttempt(ctx, attemptId);
    return null;
  },
});

export const fail = internalMutation({
  args, returns: v.null(), handler: async (ctx, input) => {
    await assertCurrentAttempt(ctx, input.attemptId);
    const claim = await ctx.db.query("reviewProbeClaims").withIndex("by_attemptId_and_path", q => q.eq("attemptId", input.attemptId).eq("path", input.path)).unique();
    if (!claim || claim.owner !== input.owner) throw new Error("Probe claim belongs to another execution");
    await ctx.db.patch(claim._id, { status: "interrupted" });
    return null;
  },
});

export const assertHealthy = internalQuery({
  args, returns: v.null(), handler: async (ctx, input) => {
    await assertCurrentAttempt(ctx, input.attemptId);
    const claim = await ctx.db.query("reviewProbeClaims").withIndex("by_attemptId_and_path", q => q.eq("attemptId", input.attemptId).eq("path", input.path)).unique();
    if (claim?.owner === input.owner && claim.status === "interrupted") throw new Error("Probe outcome is unknown after interruption; lifecycle recovery must fence the prior worker before another execution");
    return null;
  },
});
