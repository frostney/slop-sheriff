import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { asSchema, streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createGateway } from "@ai-sdk/gateway";
import { reviewWorkInputSchema } from "../src/review/work-execution";
import { withTaskReasoning } from "../src/models/routing";
import { createCostTelemetry, type CostExecutionScope } from "../src/telemetry/sdk-cost-telemetry";
import type { CostObservation } from "../src/telemetry/cost-ledger";
import { ToolInputJsonPrefix } from "../src/models/tool-input-stream";
import { completeReviewWorkInput } from "./fixtures/review-work-contract";
import { reviewWorkCheckpoint } from "../src/review/work-execution";
import { laneCheckpointContentSchema } from "../src/review/lane-checkpoint";

const scope: CostExecutionScope = { repositoryId: "fixture", repository: "fixture/contract", pullRequest: 43,
  headSha: "578235f", attemptId: "offline-contract", reviewKind: "full", sessionId: "child", turnId: "turn", stepIndex: 0, phase: "claim-and-specification" };

test("recorded prefix is syntactically possible, but its already closed checkpoint lacks the report", async () => {
  const prefix = await readFile(new URL("./fixtures/pr43-model-contract/review-work-prefix.txt", import.meta.url), "utf8");
  // Preserve the old schema keys for this historical check. The rejected next
  // fragment is unavailable; only close the outer transport for inspection.
  const validator = new ToolInputJsonPrefix(["operation", "checkpoint", "escalation"]);
  expect(() => validator.append(prefix)).not.toThrow();
  const captured = JSON.parse(prefix.slice(0, -2) + "}");
  expect(captured.checkpoint.status).toBe("complete");
  expect(captured.checkpoint).not.toHaveProperty("completedReport");
  expect(reviewWorkInputSchema.safeParse(captured).success).toBe(false);
});

test.each(["mock", "gateway"] as const)("current-format streamed completion and nested report rejection through %s", async transport => {
  const valid = completeReviewWorkInput();
  if (valid.action.operation !== "complete") throw new Error("Expected completion fixture");
  valid.action.report.candidates[0]!.evidence.push('Literal JSON {"action":null}, quotes " and backslash \\ stay text. 🤖');
  const variants = [
    { input: valid, succeeds: true },
    { input: { action: { operation: "complete", reviewedEntries: [0] } }, succeeds: false },
    { input: { action: { ...valid.action, report: { ...valid.action.report, candidates: [{ ...valid.action.report.candidates[0], id: "forged" }] } } }, succeeds: false },
    { input: { action: { ...valid.action, report: { ...valid.action.report, candidates: [{ ...valid.action.report.candidates[0], location: { path: "../escape", line: 1, symbol: null } }] } } }, succeeds: false },
  ];
  for (const { input, succeeds } of variants) {
    for (const width of [1, 7, 113]) {
      // Escape Unicode so one-character chunks exercise split escapes rather
      // than injecting invalid surrogate encoding into the HTTP fixture.
      const serialized = JSON.stringify(input).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "report", toolName: "review_work" }];
      for (let index = 0; index < serialized.length; index += width) chunks.push({ type: "tool-input-delta", id: "report", delta: serialized.slice(index, index + width) });
      chunks.push({ type: "tool-input-end", id: "report" }, { type: "tool-call", toolCallId: "report", toolName: "review_work", input: serialized },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      const model = transport === "mock" ? new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }) })
        : createGateway({ apiKey: "offline-fixture", fetch: Object.assign(async () => new Response(simulateReadableStream({
          chunks: chunks.map(chunk => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)), initialDelayInMs: null, chunkDelayInMs: null,
        }), { headers: { "content-type": "text/event-stream" } }), { preconnect: () => {} }) })("fixture/model");
      let executions = 0;
      const result = streamText({ model: withTaskReasoning(model, "medium"), prompt: "Offline streamed report", maxRetries: 0, tools: {
        review_work: { inputSchema: reviewWorkInputSchema, execute: async parsed => {
          executions++;
          if (parsed.action.operation === "read") throw new Error("Unexpected read");
          return laneCheckpointContentSchema.parse(reviewWorkCheckpoint(parsed.action).checkpoint);
        } },
      } });
      const parts = [];
      for await (const part of result.fullStream) parts.push(part);
      expect(parts.filter(part => part.type === "error")).toHaveLength(0);
      expect(parts.filter(part => part.type === "tool-error")).toHaveLength(succeeds ? 0 : 1);
      expect(executions).toBe(succeeds ? 1 : 0);
      if (succeeds) expect(parts.find(part => part.type === "tool-result")).toMatchObject({ output: { status: "complete", completedReport: valid.action.report } });
    }
  }
});

test.each([
  ["mock", "recorded"], ["gateway", "recorded"],
  ["mock", "nested-syntax"], ["gateway", "nested-syntax"],
  ["mock", "truncated"], ["gateway", "truncated"],
] as const)("%s stops %s report output before execution and keeps unknown billing visible", async (transport, scenario) => {
  const prefix = scenario === "recorded" ? await readFile(new URL("./fixtures/pr43-model-contract/review-work-prefix.txt", import.meta.url), "utf8")
    : scenario === "nested-syntax" ? '{"action":{"operation":"complete","reviewedEntries":[0],"report":{"axis":,'
    : '{"action":{"operation":"complete","reviewedEntries":[0],"report":';
  const rows: CostObservation[] = [];
  let cancelled = false, executed = false, calls = 0;
  let requestTools: unknown;
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "gen_pr43_report_fixture" },
    { type: "tool-input-start", id: "report", toolName: "review_work" },
    ...[prefix.slice(0, 5), prefix.slice(5)].map(delta => ({ type: "tool-input-delta" as const, id: "report", delta })),
    ...(scenario === "truncated" ? [{ type: "tool-input-end" as const, id: "report" }] : []),
  ];
  const provider = transport === "mock" ? new MockLanguageModelV4({ doStream: async options => {
    calls++; requestTools = options.tools;
    return { stream: new ReadableStream({ pull(controller) { const part = chunks.shift(); if (part) controller.enqueue(part); }, cancel() { cancelled = true; } }) };
  } }) : createGateway({ apiKey: "offline-fixture", fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++; requestTools = JSON.parse(String(init?.body)).tools;
    return new Response(new ReadableStream({
      pull(controller) { const part = chunks.shift(); if (part) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(part)}\n\n`)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: () => {} }) })("fixture/model");
  const errors: unknown[] = [];
  const result = streamText({ model: withTaskReasoning(provider, "medium"), prompt: "Replay the captured prefix", maxRetries: 0,
    tools: { review_work: { inputSchema: reviewWorkInputSchema, execute: async () => { executed = true; return "must not persist"; } } },
    telemetry: { isEnabled: true, integrations: [createCostTelemetry({ scope: () => scope, record: async row => { rows.push(row); } })] },
    onError: ({ error }) => { errors.push(error); },
  });
  await result.consumeStream({ onError: error => { errors.push(error); } });
  expect(requestTools).toEqual([expect.objectContaining({ name: "review_work", strict: true, inputSchema: await asSchema(reviewWorkInputSchema).jsonSchema })]);
  expect(errors.map(String).join(" ")).toContain("Invalid streamed tool JSON");
  expect(cancelled).toBe(true);
  expect(executed).toBe(false);
  expect(calls).toBe(1);
  expect(rows.at(-1)).toMatchObject({ generationId: "gen_pr43_report_fixture", outcome: "failed", sdkCostUsd: null });
});
