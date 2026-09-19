import { expect, test } from "bun:test";
import { APICallError, generateText, simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { createCostTelemetry, type CostExecutionScope } from "../src/telemetry/sdk-cost-telemetry";
import { summarizeCosts, type CostObservation } from "../src/telemetry/cost-ledger";

const scope: CostExecutionScope = {
  repositoryId: "R_test", repository: "acme/test", pullRequest: 43, headSha: "head",
  attemptId: "attempt", reviewKind: "full", sessionId: "root", turnId: "turn", stepIndex: 7, phase: "coordination",
};
const usage = { inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const tools = { inspect: tool({ inputSchema: z.strictObject({}), execute: async () => "PRIVATE_TOOL_OUTPUT" }) };
const retryError = () => new APICallError({ message: "PRIVATE_ERROR", url: "https://fixture.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true });

for (const mode of ["generate", "stream"] as const) {
  test(`official SDK ${mode} preserves every step and failed retry without double billing`, async () => {
    const rows = new Map<string, CostObservation>();
    const events: CostObservation[] = [];
    const telemetry = createCostTelemetry({ scope: () => scope, record: async row => { events.push(row); rows.set(row.eventId, row); } });
    let providerCalls = 0;
    const metadata = (id: string) => ({ gateway: { generationId: id, cost: "0.12", secret: "PRIVATE_METADATA" } });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        providerCalls++;
        if (providerCalls === 1) throw retryError();
        return { usage, warnings: [], providerMetadata: metadata(`gen_generate_${providerCalls}`),
          content: providerCalls === 2 ? [{ type: "tool-call", toolCallId: "inspect-1", toolName: "inspect", input: "{}" }] : [{ type: "text", text: "PRIVATE_RESPONSE" }],
          finishReason: { unified: providerCalls === 2 ? "tool-calls" : "stop", raw: "fixture" },
        };
      },
      doStream: async () => {
        providerCalls++;
        // Exercise a retry in the second SDK step as well as the first above.
        if (providerCalls === 2) throw retryError();
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: `gen_stream_${providerCalls}` },
          ...(providerCalls === 1 ? [{ type: "tool-call" as const, toolCallId: "inspect-1", toolName: "inspect", input: "{}" }] : []),
          { type: "finish", usage, providerMetadata: metadata(`gen_stream_${providerCalls}`), finishReason: { unified: providerCalls === 1 ? "tool-calls" : "stop", raw: "fixture" } },
        ];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
      },
    });
    const options = { model, tools, prompt: "PRIVATE_PROMPT", stopWhen: stepCountIs(2), maxRetries: 1, telemetry: { isEnabled: true, integrations: [telemetry] } };
    if (mode === "generate") expect((await generateText(options)).steps).toHaveLength(2);
    else { const result = streamText(options); await result.consumeStream(); expect(await result.steps).toHaveLength(2); }
    expect(providerCalls).toBe(3);
    expect(new Set(events.filter(row => row.outcome === "started").map(row => row.eventId)).size).toBe(providerCalls);
    const retained = [...rows.values()];
    expect(retained).toHaveLength(providerCalls);
    expect(retained.map(row => row.outcome)).toEqual(mode === "generate" ? ["failed", "succeeded", "succeeded"] : ["succeeded", "failed", "succeeded"]);
    expect(retained.map(row => row.modelAttemptIndex)).toEqual(mode === "generate" ? [0, 1, 0] : [0, 0, 1]);
    expect(new Set(retained.map(row => row.modelAttemptId)).size).toBe(2);
    expect(retained.every(row => row.stepIndex === scope.stepIndex)).toBe(true);
    const reportRows = retained.map(row => ({ ...row, gatewayCostUsd: null, gatewayStatus: "pending" as const, gatewayLookupAttempts: 0, gatewayLastError: null }));
    expect(summarizeCosts(reportRows)).toMatchObject({ calls: 3, failedCalls: 1, sdkKnownCostUsd: 0.24, inputTokens: 200, outputTokens: 40 });
    const successful = reportRows.find(row => row.generationId !== null)!;
    expect(summarizeCosts([...reportRows, { ...successful, eventId: "native-copy" }]).sdkKnownCostUsd).toBe(0.24);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  });
}

test("a terminal SDK error does not reset another generation's pending retry", async () => {
  const rows = new Map<string, CostObservation>();
  let notifyFailure!: () => void;
  const failed = new Promise<void>(resolve => { notifyFailure = resolve; });
  const telemetry = createCostTelemetry({ scope: () => scope, record: async row => {
    rows.set(row.eventId, row);
    if (row.outcome === "failed") notifyFailure();
  } });
  let calls = 0;
  const retrying = generateText({
    model: new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 1) throw retryError();
      return { content: [{ type: "text", text: "PRIVATE_RESPONSE" }], usage, warnings: [], finishReason: { unified: "stop", raw: "stop" } };
    } }), prompt: "PRIVATE_PROMPT", maxRetries: 1, telemetry: { isEnabled: true, integrations: [telemetry] },
  });
  await failed;
  await expect(generateText({ model: new MockLanguageModelV4({ doGenerate: async () => { throw retryError(); } }),
    prompt: "PRIVATE_PROMPT", maxRetries: 0, telemetry: { isEnabled: true, integrations: [telemetry] },
  })).rejects.toThrow("PRIVATE_ERROR");
  await retrying;
  expect(rows.size).toBe(3);
  expect([...rows.values()].filter(row => row.outcome === "failed")).toHaveLength(2);
  expect([...rows.values()].find(row => row.outcome === "succeeded")?.modelAttemptIndex).toBe(1);
  expect(JSON.stringify([...rows.values()])).not.toContain("PRIVATE_");
});
