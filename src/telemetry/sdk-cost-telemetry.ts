import { GatewayError, GatewayAuthenticationError, GatewayResponseError } from "@ai-sdk/gateway";
import type { Telemetry } from "ai";
import { z } from "zod";
import type { CostObservation, CostScope } from "./cost-ledger";
import { toolInputStreamValidator } from "../models/tool-input-stream";

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
  type Attempt = { observation: CostObservation };
  type Call = { stepNumber: number; retries: number; transports: number; current?: Attempt };
  // SDK callId identifies the entire generation, including all tool-loop steps.
  const calls = new Map<string, Call>();
  return {
    onStepStart({ callId, stepNumber }) {
      const call = calls.get(callId);
      if (call) {
        if (call.stepNumber !== stepNumber) { call.stepNumber = stepNumber; call.retries = -1; }
      } else calls.set(callId, { stepNumber, retries: -1, transports: 0 });
    },
    async executeLanguageModelCall({ callId, execute, modelId, functionId, tools }) {
      const scope = input.scope();
      if (!scope) {
        const call = calls.get(callId);
        if (call) delete call.current;
        return execute();
      }
      const call = calls.get(callId) ?? { stepNumber: 0, retries: -1, transports: 0 };
      calls.set(callId, call);
      const retries = ++call.retries;
      const transport = call.transports++;
      const observation: CostObservation = {
        ...scope, eventId: `sdk:${callId}:${call.stepNumber}:${transport}`, modelAttemptId: `${callId}:step:${call.stepNumber}`, modelAttemptIndex: retries,
        phase: functionId === "eve.compaction" ? "compaction" : scope.phase,
        requestedModel: modelId ?? "unknown", actualModel: modelId ?? null,
        outcome: "started", generationId: null, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, sdkCostUsd: null,
      };
      // Stream callbacks retain their own attempt even after the next step starts.
      const attempt: Attempt = { observation };
      call.current = attempt;
      // Await durable admission before invoking a potentially billable provider.
      await input.record(observation);
      const update = async (next: CostObservation) => {
        if (JSON.stringify(attempt.observation) === JSON.stringify(next)) return;
        attempt.observation = next;
        await input.record(next);
      };
      try {
        const result = await execute();
        if (typeof result === "object" && result !== null && "stream" in result && result.stream instanceof ReadableStream) {
          const reader = result.stream.getReader();
          const validateToolInput = toolInputStreamValidator(tools);
          const stream = new ReadableStream<unknown>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) { controller.close(); return; }
                await update(providerObservation(attempt.observation, chunk.value));
                validateToolInput(chunk.value);
                controller.enqueue(chunk.value);
              } catch (error) {
                try {
                  await update({ ...attempt.observation, outcome: "failed" });
                } finally {
                  // Stop upstream work even when recording the failure also fails.
                  await reader.cancel(error).catch(() => {});
                  controller.error(error);
                }
              }
            },
            async cancel(reason) {
              try {
                await update({ ...attempt.observation, outcome: "failed" });
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
        const current = attempt.observation;
        const gatewayError = GatewayError.isInstance(error) ? error : null;
        const generationId = gatewayError?.generationId ?? current.generationId;
        const rejected = !generationId && gatewayError && (GatewayAuthenticationError.isInstance(error) && gatewayError.statusCode === 401 ? "gateway-authentication" as const : gatewayError.statusCode === 402 && !GatewayResponseError.isInstance(error) ? "gateway-payment-required" as const : null);
        const failed = { ...current, generationId, outcome: "failed" as const, ...(rejected ? { nonbillableFailure: rejected } : {}) };
        attempt.observation = failed;
        await input.record(failed);
        throw error;
      }
    },
    async onLanguageModelCallEnd(event) {
      const call = calls.get(event.callId)?.current;
      if (!call) return;
      const gateway = event.providerMetadata?.gateway;
      const generationId = typeof gateway?.generationId === "string" ? gateway.generationId : null;
      const rawCost = gateway?.cost;
      const cost = typeof rawCost === "number" || (typeof rawCost === "string" && rawCost.trim() !== "") ? Number(rawCost) : NaN;
      call.observation = {
        ...call.observation, outcome: call.observation.outcome === "failed" ? "failed" : "succeeded", actualModel: event.modelId, generationId: generationId ?? call.observation.generationId,
        inputTokens: event.usage.inputTokens ?? call.observation.inputTokens, outputTokens: event.usage.outputTokens ?? call.observation.outputTokens,
        cacheReadTokens: event.usage.inputTokenDetails.cacheReadTokens ?? call.observation.cacheReadTokens,
        cacheWriteTokens: event.usage.inputTokenDetails.cacheWriteTokens ?? call.observation.cacheWriteTokens,
        sdkCostUsd: Number.isFinite(cost) && cost >= 0 ? cost : call.observation.sdkCostUsd,
      };
      await input.record(call.observation);
    },
    onEnd({ callId }) { calls.delete(callId); },
    onAbort({ callId }) { calls.delete(callId); },
    onError(event) {
      // Installed SDK terminal error events carry callId. Never clear another
      // concurrent generation's retry identity because one operation failed.
      const parsed = z.object({ callId: z.string() }).safeParse(event);
      if (parsed.success) calls.delete(parsed.data.callId);
    },
  };
}
