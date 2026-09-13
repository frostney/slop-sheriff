import { GatewayError, GatewayAuthenticationError, GatewayResponseError } from "@ai-sdk/gateway";
import type { Telemetry } from "ai";
import { z } from "zod";
import type { CostObservation, CostScope } from "./cost-ledger";

export interface CostExecutionScope extends CostScope {
  sessionId: string; turnId: string; stepIndex: number; phase: string;
}

const providerEnvelope = z.object({
  type: z.string().optional(), id: z.string().optional(),
  providerMetadata: z.object({ gateway: z.object({ generationId: z.string().optional(), cost: z.union([z.string(), z.number()]).optional() }).optional() }).optional(),
  usage: z.object({
    inputTokens: z.object({ total: z.number().optional(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }),
    outputTokens: z.object({ total: z.number().optional() }),
  }).optional(),
});

function providerObservation(current: CostObservation, value: unknown): CostObservation {
  const parsed = providerEnvelope.safeParse(value);
  if (!parsed.success) return current;
  const part = parsed.data;
  const metadata = part.providerMetadata?.gateway;
  const generationId = metadata?.generationId || (part.type === "response-metadata" && part.id?.startsWith("gen_") ? part.id : null);
  const rawCost = metadata?.cost;
  const cost = typeof rawCost === "number" || (typeof rawCost === "string" && rawCost.trim() !== "") ? Number(rawCost) : NaN;
  return {
    ...current, generationId: generationId ?? current.generationId,
    sdkCostUsd: Number.isFinite(cost) && cost >= 0 ? cost : current.sdkCostUsd,
    outcome: part.type === "error" ? "failed" : part.usage ? "succeeded" : current.outcome,
    inputTokens: part.usage?.inputTokens.total ?? current.inputTokens,
    outputTokens: part.usage?.outputTokens.total ?? current.outputTokens,
    cacheReadTokens: part.usage?.inputTokens.cacheRead ?? current.cacheReadTokens,
    cacheWriteTokens: part.usage?.inputTokens.cacheWrite ?? current.cacheWriteTokens,
  };
}

/** The official SDK wrapper runs once per transport retry, also for compaction. */
export function createCostTelemetry(input: {
  scope: () => CostExecutionScope | null;
  record: (observation: CostObservation) => Promise<void>;
}): Telemetry {
  const calls = new Map<string, { observation: CostObservation; retries: number }>();
  return {
    async executeLanguageModelCall({ callId, execute, modelId, functionId }) {
      const scope = input.scope();
      if (!scope) return execute();
      const retries = (calls.get(callId)?.retries ?? -1) + 1;
      const observation: CostObservation = {
        ...scope, eventId: `sdk:${callId}:${retries}`, modelAttemptId: callId, modelAttemptIndex: retries,
        phase: functionId === "eve.compaction" ? "compaction" : scope.phase,
        requestedModel: modelId ?? "unknown", actualModel: modelId ?? null,
        outcome: "started", generationId: null, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, sdkCostUsd: null,
      };
      calls.set(callId, { observation, retries });
      // Await durable admission before invoking a potentially billable provider.
      try { await input.record(observation); }
      catch (error) { calls.delete(callId); throw error; }
      const update = async (next: CostObservation) => {
        const previous = calls.get(callId)?.observation ?? observation;
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        calls.set(callId, { observation: next, retries });
        await input.record(next);
      };
      try {
        const result = await execute();
        if (typeof result === "object" && result !== null && "stream" in result && result.stream instanceof ReadableStream) {
          const reader = result.stream.getReader();
          const stream = new ReadableStream<unknown>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) { controller.close(); return; }
                await update(providerObservation(calls.get(callId)?.observation ?? observation, chunk.value));
                controller.enqueue(chunk.value);
              } catch (error) {
                try {
                  await update({ ...(calls.get(callId)?.observation ?? observation), outcome: "failed" });
                } finally {
                  // Stop upstream work even when recording the failure also fails.
                  await reader.cancel(error).catch(() => {});
                  controller.error(error);
                }
              }
            },
            async cancel(reason) {
              try {
                await update({ ...(calls.get(callId)?.observation ?? observation), outcome: "failed" });
              } finally {
                await reader.cancel(reason);
              }
            },
          });
          return Object.assign(result, { stream });
        }
        await update(providerObservation(observation, result));
        return result;
      } catch (error) {
        const current = calls.get(callId)?.observation ?? observation;
        const gatewayError = GatewayError.isInstance(error) ? error : null;
        const generationId = gatewayError?.generationId ?? current.generationId;
        const rejected = !generationId && gatewayError && (GatewayAuthenticationError.isInstance(error) && gatewayError.statusCode === 401 ? "gateway-authentication" as const : gatewayError.statusCode === 402 && !GatewayResponseError.isInstance(error) ? "gateway-payment-required" as const : null);
        const failed = { ...current, generationId, outcome: "failed" as const, ...(rejected ? { nonbillableFailure: rejected } : {}) };
        calls.set(callId, { observation: failed, retries });
        await input.record(failed);
        throw error;
      }
    },
    async onLanguageModelCallEnd(event) {
      const call = calls.get(event.callId);
      if (!call) return;
      const gateway = event.providerMetadata?.gateway;
      const generationId = typeof gateway?.generationId === "string" ? gateway.generationId : null;
      const rawCost = gateway?.cost;
      const cost = typeof rawCost === "number" || (typeof rawCost === "string" && rawCost.trim() !== "") ? Number(rawCost) : NaN;
      await input.record({
        ...call.observation, outcome: call.observation.outcome === "failed" ? "failed" : "succeeded", actualModel: event.modelId, generationId: generationId ?? call.observation.generationId,
        inputTokens: event.usage.inputTokens ?? null, outputTokens: event.usage.outputTokens ?? null,
        cacheReadTokens: event.usage.inputTokenDetails.cacheReadTokens ?? null,
        cacheWriteTokens: event.usage.inputTokenDetails.cacheWriteTokens ?? null,
        sdkCostUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
      });
      calls.delete(event.callId);
    },
    onError() {
      // Terminal errors release in-process correlation; durable rows remain.
      // Only failed calls are removed so concurrent successful streams keep their identity.
      for (const [id, call] of calls) if (call.observation.outcome === "failed") calls.delete(id);
    },
  };
}
