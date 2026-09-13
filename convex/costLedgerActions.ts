"use node";
import { createGateway } from "@ai-sdk/gateway";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const sweep = internalAction({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const gateway = createGateway({ fetch: Object.assign(
      (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(resource, { ...init, signal: AbortSignal.timeout(5_000) }),
      { preconnect: () => {} },
    ) });
    const rows = await ctx.runQuery(internal.costLedgerData.pending, {});
    // This scheduled action has no dependency on an Eve session or terminal hook.
    for (const row of rows) {
      try {
        const generation = await gateway.getGenerationInfo({ id: row.generationId });
        if (generation.id !== row.generationId || !Number.isFinite(generation.totalCost) || generation.totalCost < 0) throw new Error("InvalidGatewayGeneration");
        await ctx.runMutation(internal.costLedgerData.lookupResult, {
          generationId: row.generationId, costUsd: generation.totalCost, error: null,
          nativeUsage: { promptTokens: generation.promptTokens, completionTokens: generation.completionTokens,
            reasoningTokens: generation.reasoningTokens, cachedTokens: generation.cachedTokens, cacheCreationTokens: generation.cacheCreationTokens },
        });
      } catch (error) {
        await ctx.runMutation(internal.costLedgerData.lookupResult, {
          generationId: row.generationId, costUsd: null, nativeUsage: null,
          error: error instanceof Error ? error.name : "GatewayLookupFailure",
        });
      }
    }
    return null;
  },
});
