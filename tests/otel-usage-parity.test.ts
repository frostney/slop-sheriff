import { expect, test } from "bun:test";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { InstrumentationAttemptScope, InstrumentationEvent } from "eve/instrumentation";
// Eve vendors its own OpenTelemetry API; the tracer must satisfy that copy.
import type { Attributes, AttributeValue, Span, SpanContext, Tracer } from "../node_modules/eve/dist/src/compiled/@opentelemetry/api/index.js";
// The integration Eve registers in production, not a second copy that could
// drift from the version Eve vendors.
import { OpenTelemetry } from "../node_modules/eve/dist/src/compiled/@ai-sdk/otel/index.js";
import { createAiSdkHookBridge } from "../node_modules/eve/dist/src/instrumentation/ai-sdk-hook-bridge.js";
import { createInstrumentationDispatcher } from "../node_modules/eve/dist/src/instrumentation/dispatch.js";
import { ContextContainer, contextStorage } from "./fixtures/eve-context";
import provider from "../agent/instrumentation/observations";
import { modelObservations } from "../agent/lib/model-observations";
import { recordTurnUsage, summarizeTurnUsage, type TurnUsageState } from "../src/telemetry/turn-usage";

interface RecordedSpan { readonly name: string; readonly attributes: Record<string, AttributeValue> }

function recordingTracer(spans: RecordedSpan[]): Tracer {
  return {
    startSpan(name, options) {
      const attributes: Record<string, AttributeValue> = {};
      const set = (values: Attributes) => {
        for (const [key, value] of Object.entries(values)) if (value !== undefined) attributes[key] = value;
      };
      set(options?.attributes ?? {});
      const context: SpanContext = { traceId: "1".padStart(32, "0"), spanId: String(spans.length + 1).padStart(16, "0"), traceFlags: 1 };
      // The vendored Span type omits setAttributes, which the integration calls.
      const span: Span & { setAttributes(values: Attributes): Span } = {
        spanContext: () => context,
        setAttribute(key, value) { set({ [key]: value }); return span; },
        setAttributes(values) { set(values); return span; },
        addEvent: () => span, setStatus: () => span, recordException: () => {},
        end: () => { spans.push({ name, attributes }); },
      };
      return span;
    },
  };
}

const usages = [
  { input: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 }, output: { total: 20, text: 15, reasoning: 5 }, generationId: "gen-a", cost: "0.01" },
  { input: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 }, output: { total: 7, text: 7, reasoning: 0 }, generationId: "gen-b", cost: "0.004" },
];

test("eve's gen_ai.usage spans carry the same token totals as turn usage, and no cost", async () => {
  const spans: RecordedSpan[] = [];
  const otel = new OpenTelemetry({ tracer: recordingTracer(spans) });
  await contextStorage.run(new ContextContainer(), async () => {
    for (const [attemptIndex, usage] of usages.entries()) {
      const scope: InstrumentationAttemptScope = {
        sessionId: "otel-session", turnId: "otel-turn", stepIndex: attemptIndex,
        attemptId: `otel-session:otel-turn:${attemptIndex}:0`, attemptIndex: 0,
      };
      const dispatch = createInstrumentationDispatcher([{ name: "production", ...provider }], {})
        .forTrace?.({ agentName: "test", audience: "public" });
      if (!dispatch) throw new Error("Expected a bound instrumentation dispatcher");
      const events: InstrumentationEvent[] = [];
      const model = new MockLanguageModelV4({
        modelId: "fixture-model", provider: "fixture-provider",
        doGenerate: {
          content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, warnings: [],
          usage: { inputTokens: usage.input, outputTokens: usage.output },
          providerMetadata: { gateway: { generationId: usage.generationId, cost: usage.cost } },
        },
      });
      await generateText({ model, prompt: "p", telemetry: { isEnabled: true,
        integrations: [createAiSdkHookBridge(scope, { ...dispatch, publish: async (event: InstrumentationEvent) => {
          events.push(event); await dispatch.publish(event);
        } }), otel] } });
      expect(events.some(event => event.type === "model.call.completed")).toBe(true);
    }
    let state: TurnUsageState | null = null;
    for (const observation of modelObservations.get()) state = recordTurnUsage(state, observation);
    if (!state) throw new Error("Expected turn usage");
    const summary = summarizeTurnUsage(state);

    const calls = spans.filter(span => span.name.startsWith("chat "));
    expect(calls).toHaveLength(usages.length);
    const total = (key: string) => calls.reduce((sum, span) => sum + Number(span.attributes[key] ?? 0), 0);
    expect(summary).toMatchObject({ modelSteps: 2, sdkCostUsd: 0.014 });
    expect(total("gen_ai.usage.input_tokens")).toBe(summary.inputTokens ?? Number.NaN);
    expect(total("gen_ai.usage.output_tokens")).toBe(summary.outputTokens ?? Number.NaN);
    expect(total("gen_ai.usage.cache_read.input_tokens")).toBe(summary.cacheReadTokens ?? Number.NaN);
    expect(total("gen_ai.usage.cache_creation.input_tokens")).toBe(summary.cacheWriteTokens ?? Number.NaN);
    // Spans have no cost attribute: cost stays sourced from Gateway metadata
    // and reconciled through getGenerationInfo.
    expect(spans.flatMap(span => Object.keys(span.attributes)).filter(key => /cost/i.test(key))).toEqual([]);
  });
});
