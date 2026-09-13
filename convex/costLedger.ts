import { defineTable } from "convex/server";
import { v } from "convex/values";

const amount = v.union(v.number(), v.null());
export const vCostObservation = v.object({
  repositoryId: v.string(), repository: v.string(), pullRequest: v.number(), headSha: v.string(),
  attemptId: v.string(), reviewKind: v.union(v.literal("full"), v.literal("delta")),
  eventId: v.string(), sessionId: v.string(), turnId: v.string(), stepIndex: v.number(),
  modelAttemptId: v.string(), modelAttemptIndex: v.number(), phase: v.string(), requestedModel: v.string(),
  actualModel: v.union(v.string(), v.null()), generationId: v.union(v.string(), v.null()),
  nonbillableFailure: v.optional(v.union(v.literal("gateway-authentication"), v.literal("gateway-payment-required"))),
  outcome: v.union(v.literal("started"), v.literal("succeeded"), v.literal("failed")),
  inputTokens: amount, outputTokens: amount, cacheReadTokens: amount, cacheWriteTokens: amount, sdkCostUsd: amount,
});
export const vCostGeneration = v.object({
  repositoryId: v.string(), pullRequest: v.number(), headSha: v.string(), attemptId: v.string(),
  generationId: v.string(), status: v.union(v.literal("pending"), v.literal("resolved")),
  costUsd: amount, lookupAttempts: v.number(), lastError: v.union(v.string(), v.null()), nextLookupAt: v.number(),
  nativeUsage: v.union(v.null(), v.object({
    promptTokens: v.number(), completionTokens: v.number(), reasoningTokens: v.number(),
    cachedTokens: v.number(), cacheCreationTokens: v.number(),
  })),
});
export const costLedgerTables = {
  costObservations: defineTable({ ...vCostObservation.fields, observedAt: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()) })
    .index("by_event_id", ["eventId"])
    .index("by_attemptId", ["attemptId"])
    .index("by_repository_id_and_pull_request", ["repositoryId", "pullRequest"]),
  costGenerations: defineTable(vCostGeneration)
    .index("by_generation_id", ["generationId"])
    .index("by_status_and_next_lookup_at", ["status", "nextLookupAt"]),
};
