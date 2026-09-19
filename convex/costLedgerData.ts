import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { vCostGeneration, vCostObservation } from "./costLedger";

export const record = internalMutation({
  args: { observation: vCostObservation }, returns: v.null(),
  handler: async (ctx, { observation }) => {
    const prior = await ctx.db.query("costObservations").withIndex("by_event_id", q => q.eq("eventId", observation.eventId)).unique();
    if (prior && (prior.attemptId !== observation.attemptId || prior.repositoryId !== observation.repositoryId || prior.headSha !== observation.headSha || prior.pullRequest !== observation.pullRequest)) {
      throw new Error("Cost observation identity conflict");
    }
    // Start-event replay cannot erase a completed or failed attempt or learned metadata.
    const merged = prior ? {
      ...observation,
      outcome: observation.outcome === "started" ? prior.outcome : observation.outcome,
      generationId: observation.generationId ?? prior.generationId,
      actualModel: observation.actualModel ?? prior.actualModel,
      sdkCostUsd: observation.sdkCostUsd ?? prior.sdkCostUsd,
      inputTokens: observation.inputTokens ?? prior.inputTokens, outputTokens: observation.outputTokens ?? prior.outputTokens,
      cacheReadTokens: observation.cacheReadTokens ?? prior.cacheReadTokens, cacheWriteTokens: observation.cacheWriteTokens ?? prior.cacheWriteTokens,
    } : observation;
    if (prior?.generationId && observation.generationId && prior.generationId !== observation.generationId) throw new Error("Cost generation identity conflict");
    const timing = {
      ...(!prior && observation.outcome === "started" ? { startedAt: Date.now() } : {}),
      ...(prior?.finishedAt === undefined && merged.outcome !== "started" ? { finishedAt: Date.now() } : {}),
    };
    if (prior) await ctx.db.patch(prior._id, { ...merged, ...timing });
    else await ctx.db.insert("costObservations", { ...merged, ...timing, observedAt: Date.now() });
    if (merged.generationId) {
      const existing = await ctx.db.query("costGenerations").withIndex("by_generation_id", q => q.eq("generationId", merged.generationId!)).unique();
      if (existing && (existing.repositoryId !== merged.repositoryId || existing.pullRequest !== merged.pullRequest || existing.headSha !== merged.headSha || existing.attemptId !== merged.attemptId)) throw new Error("Gateway generation ownership conflict");
      if (!existing) await ctx.db.insert("costGenerations", {
        repositoryId: merged.repositoryId, pullRequest: merged.pullRequest, headSha: merged.headSha, attemptId: merged.attemptId,
        generationId: merged.generationId, status: "pending", costUsd: null, nativeUsage: null,
        lookupAttempts: 0, lastError: null, nextLookupAt: Date.now(),
      });
    }
    return null;
  },
});
export const pending = internalQuery({
  args: {}, returns: v.array(vCostGeneration),
  handler: async ctx => (await ctx.db.query("costGenerations")
    .withIndex("by_status_and_next_lookup_at", q => q.eq("status", "pending").lte("nextLookupAt", Date.now()))
    .take(50)).map(({ _id, _creationTime, ...row }) => row),
});
export const lookupResult = internalMutation({
  args: {
    generationId: v.string(), costUsd: v.union(v.number(), v.null()),
    nativeUsage: vCostGeneration.fields.nativeUsage, error: v.union(v.string(), v.null()),
  }, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("costGenerations").withIndex("by_generation_id", q => q.eq("generationId", args.generationId)).unique();
    if (!row || row.status === "resolved") return null;
    await ctx.db.patch(row._id, {
      status: args.costUsd === null ? "pending" : "resolved", costUsd: args.costUsd,
      nativeUsage: args.nativeUsage, lookupAttempts: row.lookupAttempts + 1, lastError: args.error,
      // Retry scheduling limits pressure on telemetry services, never review coverage.
      nextLookupAt: Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.lookupAttempts, 6)),
    });
    return null;
  },
});
export const report = internalQuery({
  args: { repositoryId: v.string(), pullRequest: v.number(), paginationOpts: paginationOptsValidator },
  returns: v.object({ rows: v.array(v.object({
    ...vCostObservation.fields, gatewayCostUsd: v.union(v.number(), v.null()),
    gatewayStatus: v.union(v.literal("pending"), v.literal("resolved"), v.literal("missing-generation")),
    gatewayLookupAttempts: v.number(), gatewayLastError: v.union(v.string(), v.null()),
    startedAt: v.union(v.number(), v.null()), finishedAt: v.union(v.number(), v.null()),
  })), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("costObservations")
      .withIndex("by_repository_id_and_pull_request", q => q.eq("repositoryId", args.repositoryId).eq("pullRequest", args.pullRequest))
      .paginate(args.paginationOpts);
    const rows = await Promise.all(page.page.map(async ({ _id, _creationTime, observedAt, ...row }) => {
      const generation = row.generationId ? await ctx.db.query("costGenerations").withIndex("by_generation_id", q => q.eq("generationId", row.generationId!)).unique() : null;
      return { ...row, startedAt: row.startedAt ?? null, finishedAt: row.finishedAt ?? null, gatewayCostUsd: generation?.costUsd ?? null,
        gatewayStatus: generation?.status ?? "missing-generation" as const,
        gatewayLookupAttempts: generation?.lookupAttempts ?? 0, gatewayLastError: generation?.lastError ?? null };
    }));
    return { rows, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** Explicit native Gateway admission rejection is proof; missing or unfinished telemetry is not. */
export const nonbillableAttempt = internalQuery({
  args: { attemptId: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.object({ observedCalls: v.number(), rejectedCalls: v.number(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { attemptId, paginationOpts }) => {
    const page = await ctx.db.query("costObservations").withIndex("by_attemptId", q => q.eq("attemptId", attemptId)).paginate(paginationOpts);
    const rejectedCalls = page.page.filter(row => row.outcome === "failed" && row.nonbillableFailure && !row.generationId &&
      [row.sdkCostUsd, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens].every(value => value === null || value === 0)).length;
    return { observedCalls: page.page.length, rejectedCalls, cursor: page.isDone ? null : page.continueCursor };
  },
});
