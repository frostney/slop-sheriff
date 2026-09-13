import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import { generateText, streamText, APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createGateway } from "@ai-sdk/gateway";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { createCostTelemetry, type CostExecutionScope } from "../src/telemetry/sdk-cost-telemetry";
import { costLifecycleReport, type CostObservation } from "../src/telemetry/cost-ledger";
import { ContextContainer, contextStorage, serializeContext, deserializeContext } from "./fixtures/eve-context";
import costHook from "../agent/hooks/cost-ledger";
import { costExecutionScope, recordDurableCost } from "../agent/lib/cost-ledger";
import type { HookContext, HookEvent } from "eve/hooks";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/costLedgerData.ts": () => import("../convex/costLedgerData"),
  "../convex/costLedgerActions.ts": () => import("../convex/costLedgerActions"),
};
const scope: CostExecutionScope = {
  repositoryId: "R_test", repository: "acme/test", pullRequest: 43, headSha: "head",
  attemptId: "attempt-1", reviewKind: "full", sessionId: "root", turnId: "turn", stepIndex: 0, phase: "coordination",
};
const result = {
  content: [{ type: "text" as const, text: "PRIVATE_RESPONSE" }],
  finishReason: { unified: "stop" as const, raw: "stop" }, warnings: [],
  usage: { inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
  providerMetadata: { gateway: { generationId: "gen_test", cost: "0.12", secret: "PRIVATE_METADATA" } },
};
const start: CostObservation = {
  ...scope, eventId: "call", modelAttemptId: "sdk-call", modelAttemptIndex: 0,
  requestedModel: "fixture", actualModel: "fixture", generationId: null, outcome: "started",
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, sdkCostUsd: null,
};

test("official SDK records each transport retry and compaction without retaining private content", async () => {
  const rows = new Map<string, CostObservation>();
  let tries = 0;
  const telemetry = createCostTelemetry({ scope: () => scope, record: async row => { rows.set(row.eventId, row); } });
  await generateText({ model: new MockLanguageModelV4({
    doGenerate: async () => {
      tries += 1;
      expect([...rows.values()].at(-1)?.outcome).toBe("started");
      if (tries === 1) throw new APICallError({ message: "retry", url: "https://fixture.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      return result;
    },
  }), prompt: "PRIVATE_PROMPT", maxRetries: 1,
  telemetry: { isEnabled: true, functionId: "eve.compaction", integrations: [telemetry] } });
  expect([...rows.values()].map(row => row.outcome)).toEqual(["failed", "succeeded"]);
  expect([...rows.values()].map(row => row.modelAttemptIndex)).toEqual([0, 1]);
  expect([...rows.values()].every(row => row.phase === "compaction")).toBe(true);
  expect([...rows.values()][1]).toMatchObject({ generationId: "gen_test", sdkCostUsd: 0.12, inputTokens: 100, cacheReadTokens: 30 });
  expect(JSON.stringify([...rows.values()])).not.toContain("PRIVATE_");
});

test("captures early Gateway metadata before a failed stream through the installed provider", async () => {
  const rows = new Map<string, CostObservation>();
  const telemetry = createCostTelemetry({ scope: () => scope, record: async row => { rows.set(row.eventId, row); } });
  let release: (() => void) | undefined;
  const waitForFailure = new Promise<void>(resolve => { release = resolve; });
  const gateway = createGateway({ apiKey: "offline-test-key", fetch: Object.assign(async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response-metadata", id: "gen_stream" })}\n\n`));
      await waitForFailure;
      controller.error(new Error("provider connection lost"));
    },
  }), { headers: { "content-type": "text/event-stream" } }), { preconnect: () => {} }) });
  const streamed = streamText({ model: gateway("fixture/model"), prompt: "PRIVATE_PROMPT", maxRetries: 0,
    telemetry: { isEnabled: true, integrations: [telemetry] } });
  const consumption = streamed.consumeStream({ onError: () => {} });
  for (let index = 0; index < 100 && ![...rows.values()].some(row => row.generationId === "gen_stream"); index += 1) await new Promise(resolve => setTimeout(resolve, 1));
  expect([...rows.values()][0]).toMatchObject({ generationId: "gen_stream", outcome: "started" });
  release?.();
  await consumption;
  expect([...rows.values()][0]).toMatchObject({ generationId: "gen_stream", outcome: "failed" });
});

test("durable rows survive failed attempts and independently reconcile delayed Gateway billing once", async () => {
  const t = convexTest(schema, modules);
  const full = { ...start, generationId: "gen_full", outcome: "succeeded" as const, sdkCostUsd: 1, inputTokens: 100, outputTokens: 20 };
  const failedDelta = { ...start, eventId: "delta", attemptId: "attempt-2", reviewKind: "delta" as const, generationId: "gen_delta", outcome: "failed" as const, sdkCostUsd: 2 };
  await t.mutation(internal.costLedgerData.record, { observation: full });
  await t.mutation(internal.costLedgerData.record, { observation: start });
  await t.mutation(internal.costLedgerData.record, { observation: failedDelta });
  // Duplicate native observation cannot create a second billed generation.
  await t.mutation(internal.costLedgerData.record, { observation: { ...full, eventId: "native-copy", sdkCostUsd: null, inputTokens: null, outputTokens: null } });
  expect(await t.query(internal.costLedgerData.pending, {})).toHaveLength(2);
  const args = { repositoryId: scope.repositoryId, pullRequest: 43, paginationOpts: { numItems: 100, cursor: null } };
  const before = costLifecycleReport((await t.query(internal.costLedgerData.report, args)).rows);
  expect(before.cumulative).toMatchObject({ calls: 2, totalCostUsd: null, unresolvedCalls: 2, sdkKnownCostUsd: 3, failedCalls: 1 });
  const key = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "offline-fixture";
  let lookups = 0;
  let delayed = true;
  const clock = spyOn(Date, "now");
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: unknown) => {
    lookups += 1;
    if (delayed) return Response.json({ error: { message: "Not ready" } }, { status: 404 });
    const id = new URL(String(url)).searchParams.get("id");
    return Response.json({ data: { id, total_cost: id === "gen_full" ? 1.1 : 2.2, upstream_inference_cost: 0,
      usage: 0, created_at: "2026-09-13T00:00:00Z", model: "fixture/model", is_byok: false,
      provider_name: "fixture", streamed: false, finish_reason: "stop", latency: 1, generation_time: 2,
      native_tokens_prompt: 100, native_tokens_completion: 20, native_tokens_reasoning: 0,
      native_tokens_cached: 30, native_tokens_cache_creation: 10, billable_web_search_calls: 0 } });
  }, { preconnect: () => {} }));
  try {
    await t.action(internal.costLedgerActions.sweep, {});
    expect((await t.query(internal.costLedgerData.report, args)).rows.every(row => row.gatewayStatus === "pending")).toBe(true);
    delayed = false;
    clock.mockReturnValue(Date.now() + 120_000);
    await t.action(internal.costLedgerActions.sweep, {});
    const after = costLifecycleReport((await t.query(internal.costLedgerData.report, args)).rows);
    expect(after.cumulative.totalCostUsd).toBeCloseTo(3.3);
    expect(after.full.totalCostUsd).toBe(1.1);
    expect(after.delta.totalCostUsd).toBe(2.2);
    expect(after.attempts).toHaveLength(2);
    expect(after.cumulative.failedCalls).toBe(1);
    await t.action(internal.costLedgerActions.sweep, {});
    expect(lookups).toBe(4);
  } finally { network.mockRestore(); clock.mockRestore(); if (key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = key; }
});

test("rejects rewritten cost ownership and reports missing generation usage as unknown", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.costLedgerData.record, { observation: start });
  await expect(t.mutation(internal.costLedgerData.record, { observation: { ...start, attemptId: "forged" } })).rejects.toThrow("identity conflict");
  const page = await t.query(internal.costLedgerData.report, { repositoryId: scope.repositoryId, pullRequest: 43, paginationOpts: { numItems: 1, cursor: null } });
  expect(costLifecycleReport(page.rows).cumulative).toMatchObject({ unfinishedCalls: 1, totalCostUsd: null, missingGenerationCalls: 1, unknownTokenCalls: 1 });
  await t.mutation(internal.costLedgerData.record, { observation: { ...start, generationId: "gen_owned" } });
  await expect(t.mutation(internal.costLedgerData.record, { observation: { ...start, eventId: "other", attemptId: "other-attempt", generationId: "gen_owned" } })).rejects.toThrow("ownership conflict");
});

test("phase latency retains original boundaries across replay and overlapping calls", async () => {
  const t = convexTest(schema, modules);
  const clock = spyOn(Date, "now").mockReturnValue(1_000);
  try {
    await t.mutation(internal.costLedgerData.record, { observation: start });
    clock.mockReturnValue(2_000);
    await t.mutation(internal.costLedgerData.record, { observation: { ...start, eventId: "overlap" } });
    clock.mockReturnValue(4_000);
    await t.mutation(internal.costLedgerData.record, { observation: { ...start, outcome: "succeeded" } });
    clock.mockReturnValue(5_000);
    await t.mutation(internal.costLedgerData.record, { observation: { ...start, eventId: "overlap", outcome: "failed" } });
    clock.mockReturnValue(9_000);
    await t.mutation(internal.costLedgerData.record, { observation: start });
    await t.mutation(internal.costLedgerData.record, { observation: { ...start, outcome: "succeeded" } });
    const page = await t.query(internal.costLedgerData.report, { repositoryId: scope.repositoryId, pullRequest: 43, paginationOpts: { numItems: 100, cursor: null } });
    expect(page.rows.find(row => row.eventId === start.eventId)).toMatchObject({ startedAt: 1_000, finishedAt: 4_000 });
    expect(costLifecycleReport(page.rows).phases[0]).toMatchObject({ modelActivitySpanMs: 4_000, callsWithUnknownTiming: 0 });
  } finally { clock.mockRestore(); }
});

test("SDK does not invoke a provider when durable admission fails", async () => {
  let calls = 0;
  const telemetry = createCostTelemetry({ scope: () => scope, record: async () => { throw new Error("LedgerUnavailable"); } });
  await expect(generateText({ model: new MockLanguageModelV4({ doGenerate: async () => { calls += 1; return result; } }),
    prompt: "fixture", maxRetries: 0, telemetry: { isEnabled: true, integrations: [telemetry] },
  })).rejects.toThrow("LedgerUnavailable");
  expect(calls).toBe(0);
});

test("a superseded attempt cannot reach the provider or cost admission", async () => {
  const originalUrl = process.env.CONVEX_MEMORY_URL;
  const originalToken = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.CONVEX_MEMORY_URL = "https://review.test";
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "fixture-service-token";
  const requests: string[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(false);
  }, { preconnect: () => {} }));
  let providerCalls = 0;
  try {
    const telemetry = createCostTelemetry({ scope: () => scope, record: recordDurableCost });
    await expect(generateText({ model: new MockLanguageModelV4({ doGenerate: async () => { providerCalls++; return result; } }),
      prompt: "fixture", maxRetries: 0, telemetry: { isEnabled: true, integrations: [telemetry] },
    })).rejects.toThrow();
    expect(providerCalls).toBe(0);
    expect(requests).toEqual(["https://review.test/review-lifecycle/fence"]);
  } finally {
    network.mockRestore();
    if (originalUrl === undefined) delete process.env.CONVEX_MEMORY_URL; else process.env.CONVEX_MEMORY_URL = originalUrl;
    if (originalToken === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN; else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = originalToken;
  }
});

test("ledger failure cancels an active provider stream even when failure recording also rejects", async () => {
  let canceled = false;
  const telemetry = createCostTelemetry({ scope: () => scope, record: async row => {
    if (row.generationId) throw new Error("LedgerUnavailable");
  } });
  const model = new MockLanguageModelV4({ doStream: {
    stream: new ReadableStream({
      start(controller) { controller.enqueue({ type: "response-metadata", id: "gen_failure" }); },
      cancel() { canceled = true; },
    }),
  } });
  const streamed = streamText({ model, prompt: "fixture", maxRetries: 0, telemetry: { isEnabled: true, integrations: [telemetry] } });
  await streamed.consumeStream({ onError: () => {} });
  expect(canceled).toBe(true);
});

test("installed Gateway normalizes raw HTTP retries and preserves both billable attempt records", async () => {
  const rows = new Map<string, CostObservation>();
  let requests = 0;
  const gateway = createGateway({ apiKey: "offline-test-key", fetch: Object.assign(async () => {
    requests += 1;
    return requests === 1 ? Response.json({ error: { message: "provider unavailable" } }, { status: 503 }) : Response.json(result);
  }, { preconnect: () => {} }) });
  await generateText({ model: gateway("fixture/model"), prompt: "fixture", maxRetries: 1,
    telemetry: { isEnabled: true, integrations: [createCostTelemetry({ scope: () => scope, record: async row => { rows.set(row.eventId, row); } })] },
  });
  expect(requests).toBe(2);
  expect([...rows.values()].map(row => row.outcome)).toEqual(["failed", "succeeded"]);
  expect([...rows.values()].map(row => row.modelAttemptIndex)).toEqual([0, 1]);
});

test("real Eve context serialization retains trusted accounting identity and counts paid control continuations and clears unrelated turns", async () => {
  const ctx = { channel: { kind: "subagent" }, session: { id: "child", auth: { current: { attributes: {
    repository: "acme/test", installation_id: "1", pull_request_number: "43", delivery_id: "execution-lease",
    known_good_review_event: "review-control-response", known_good_review_plan: JSON.stringify({ kind: "delta" }), known_good_review_repository_created_at: "0",
    known_good_review_repository_id: "R_test", known_good_review_base_sha: "base", known_good_review_head_sha: "head",
  } } } } } as unknown as HookContext;
  const event = { type: "turn.started", meta: { id: "turn", at: "2026-09-13T00:00:00Z" }, data: { turnId: "turn" } } as HookEvent<"turn.started">;
  const initial = new ContextContainer();
  await contextStorage.run(initial, async () => { await costHook.events?.["turn.started"]?.(event, ctx); });
  const restored = await deserializeContext(structuredClone(serializeContext(initial)));
  await contextStorage.run(restored, async () => {
    expect(costExecutionScope.get()).toMatchObject({ attemptId: "execution-lease", sessionId: "child", reviewKind: "delta", headSha: "head" });
    const control = { ...ctx, session: { ...ctx.session, auth: { current: null } } } as HookContext;
    await costHook.events?.["turn.started"]?.(event, control);
    expect(costExecutionScope.get()).toBeNull();
  });
});

test("raw installed Gateway admission rejections are proof only with complete failed transport records", async () => {
  for (const fixture of [
    { status: 401, body: { error: { type: "authentication_error", message: "fixture denied" } }, expected: true },
    { status: 402, body: { error: { type: "invalid_request_error", message: "fixture credits" } }, expected: true },
    { status: 402, body: { error: { type: "invalid_request_error", message: "fixture credits" }, generationId: "gen_rejected" }, expected: false },
    { status: 402, body: { unexpected: "malformed" }, expected: false },
    { status: 503, body: { error: { type: "internal_server_error", message: "fixture failed" } }, expected: false },
  ]) {
    const t = convexTest(schema, modules);
    const gateway = createGateway({ apiKey: "offline-test-key", fetch: Object.assign(async () => Response.json(fixture.body, { status: fixture.status }), { preconnect: () => {} }) });
    const telemetry = createCostTelemetry({ scope: () => scope, record: observation => t.mutation(internal.costLedgerData.record, { observation }).then(() => {}) });
    await expect(generateText({ model: gateway("fixture/model"), prompt: "fixture", maxRetries: 0, telemetry: { isEnabled: true, integrations: [telemetry] } })).rejects.toThrow();
    const proof = await t.query(internal.costLedgerData.nonbillableAttempt, { attemptId: scope.attemptId, paginationOpts: { numItems: 100, cursor: null } });
    expect(proof.observedCalls).toBe(1);
    expect(proof.rejectedCalls === proof.observedCalls).toBe(fixture.expected);
    await t.mutation(internal.costLedgerData.record, { observation: { ...start, eventId: "unfinished" } });
    const unresolved = await t.query(internal.costLedgerData.nonbillableAttempt, { attemptId: scope.attemptId, paginationOpts: { numItems: 100, cursor: null } });
    expect(unresolved.rejectedCalls).toBeLessThan(unresolved.observedCalls);
    const missing = await t.query(internal.costLedgerData.nonbillableAttempt, { attemptId: "missing", paginationOpts: { numItems: 100, cursor: null } });
    expect(missing.observedCalls).toBe(0);
  }
});
