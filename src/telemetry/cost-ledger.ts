import { z } from "zod";

const amount = z.number().nonnegative().nullable();
export const costScopeSchema = z.object({
  repositoryId: z.string().min(1), repository: z.string().min(1),
  pullRequest: z.number().int().positive(), headSha: z.string().min(1),
  attemptId: z.string().min(1), reviewKind: z.enum(["full", "delta"]),
});
export const costObservationSchema = z.object({
  ...costScopeSchema.shape,
  eventId: z.string().min(1), sessionId: z.string().min(1), turnId: z.string(),
  stepIndex: z.number().int(), modelAttemptId: z.string(), modelAttemptIndex: z.number().int().nonnegative(),
  phase: z.string(), requestedModel: z.string(), actualModel: z.string().nullable(),
  nonbillableFailure: z.enum(["gateway-authentication", "gateway-payment-required"]).optional(),
  generationId: z.string().nullable(), outcome: z.enum(["started", "succeeded", "failed"]),
  inputTokens: amount, outputTokens: amount, cacheReadTokens: amount, cacheWriteTokens: amount, sdkCostUsd: amount,
});
export type CostScope = z.infer<typeof costScopeSchema>;
export type CostObservation = Omit<z.infer<typeof costObservationSchema>, "nonbillableFailure"> & { nonbillableFailure?: "gateway-authentication" | "gateway-payment-required" };
export const costReportRequestSchema = z.object({
  repositoryId: z.string().min(1), pullRequest: z.number().int().positive(),
  cursor: z.string().nullable().default(null),
});
export const costReportRowSchema = costObservationSchema.extend({
  gatewayCostUsd: amount, gatewayStatus: z.enum(["pending", "resolved", "missing-generation"]),
  gatewayLookupAttempts: z.number().int().nonnegative(), gatewayLastError: z.string().nullable(),
  startedAt: z.number().nullable().optional(), finishedAt: z.number().nullable().optional(),
});
export const costReportPageSchema = z.object({
  rows: z.array(costReportRowSchema), cursor: z.string().nullable(),
});
export type CostReportRow = z.infer<typeof costReportRowSchema>;

/** Replays and SDK/native envelopes sharing a generation are billed once. */
export function summarizeCosts(rows: readonly CostReportRow[]) {
  const unique = new Map<string, CostReportRow>();
  for (const row of rows) {
    const key = row.generationId ? `generation:${row.generationId}` : `event:${row.eventId}`;
    const prior = unique.get(key);
    if (prior?.gatewayCostUsd !== null && prior?.gatewayCostUsd !== undefined && row.gatewayCostUsd !== null && prior.gatewayCostUsd !== row.gatewayCostUsd) {
      throw new Error("Conflicting reconciled cost for one Gateway generation");
    }
    unique.set(key, prior ? {
      ...row,
      gatewayCostUsd: row.gatewayCostUsd ?? prior.gatewayCostUsd,
      gatewayStatus: prior.gatewayStatus === "resolved" ? "resolved" : row.gatewayStatus,
      sdkCostUsd: row.sdkCostUsd ?? prior.sdkCostUsd,
      inputTokens: row.inputTokens ?? prior.inputTokens, outputTokens: row.outputTokens ?? prior.outputTokens,
      cacheReadTokens: row.cacheReadTokens ?? prior.cacheReadTokens, cacheWriteTokens: row.cacheWriteTokens ?? prior.cacheWriteTokens,
      outcome: row.outcome === "failed" || prior.outcome === "failed" ? "failed" :
        row.outcome === "succeeded" || prior.outcome === "succeeded" ? "succeeded" : "started",
    } : row);
  }
  const calls = [...unique.values()];
  const unresolved = calls.filter(row => row.gatewayStatus !== "resolved");
  return {
    calls: calls.length, failedCalls: calls.filter(row => row.outcome === "failed").length,
    unfinishedCalls: calls.filter(row => row.outcome === "started").length,
    sdkKnownCostUsd: calls.reduce((sum, row) => sum + (row.sdkCostUsd ?? 0), 0),
    sdkUnknownCostCalls: calls.filter(row => row.sdkCostUsd === null).length,
    gatewayKnownCostUsd: calls.reduce((sum, row) => sum + (row.gatewayCostUsd ?? 0), 0),
    reconciledCalls: calls.length - unresolved.length,
    unresolvedCalls: unresolved.length,
    missingGenerationCalls: unresolved.filter(row => row.generationId === null).length,
    // Null means the bill is incomplete, never a claim that unknown usage is free.
    totalCostUsd: unresolved.length === 0 ? calls.reduce((sum, row) => sum + (row.gatewayCostUsd ?? 0), 0) : null,
    inputTokens: calls.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    cacheReadTokens: calls.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: calls.reduce((sum, row) => sum + (row.cacheWriteTokens ?? 0), 0),
    unknownTokenCalls: calls.filter(row => row.inputTokens === null || row.outputTokens === null).length,
  };
}

export function costLifecycleReport(rows: readonly CostReportRow[]) {
  const group = (key: "attemptId" | "headSha") => {
    const groups = new Map<string, CostReportRow[]>();
    for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
    return groups;
  };
  const attempts = group("attemptId");
  const heads = group("headSha");
  const phases = new Map<string, CostReportRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.attemptId, row.phase]);
    phases.set(key, [...(phases.get(key) ?? []), row]);
  }
  return {
    cumulative: summarizeCosts(rows),
    full: summarizeCosts(rows.filter(row => row.reviewKind === "full")),
    delta: summarizeCosts(rows.filter(row => row.reviewKind === "delta")),
    attempts: [...attempts].map(([attemptId, calls]) => ({ attemptId, headSha: calls[0]?.headSha, reviewKind: calls[0]?.reviewKind, ...summarizeCosts(calls) })),
    heads: [...heads].map(([headSha, calls]) => ({ headSha, ...summarizeCosts(calls) })),
    phases: [...phases.values()].map(calls => {
      const starts = calls.flatMap(call => call.startedAt == null ? [] : [call.startedAt]);
      const finishes = calls.flatMap(call => call.finishedAt == null ? [] : [call.finishedAt]);
      const completeTiming = starts.length === calls.length && finishes.length === calls.length;
      return { attemptId: calls[0]?.attemptId, phase: calls[0]?.phase, ...summarizeCosts(calls),
        modelActivitySpanMs: completeTiming ? Math.max(...finishes) - Math.min(...starts) : null,
        callsWithUnknownTiming: calls.filter(call => call.startedAt == null || call.finishedAt == null).length,
      };
    }),
  };
}
