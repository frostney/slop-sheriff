import { expect, test } from "bun:test";
import { asSchema, generateText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { reviewWorkInputSchema, reviewWorkCheckpoint } from "../src/review/work-execution";
import { inspectReviewSourceInputSchema, sourceInspectionRequest } from "../src/review/source-observations";
import { withTaskReasoning } from "../src/models/routing";
import { laneCheckpointContentSchema } from "../src/review/lane-checkpoint";
import { serializeInputSchema, toInputSchema } from "../node_modules/eve/dist/src/tools/schema.js";
import { qualityWorkTools, qualityWorkToolSchemas } from "../src/evaluation/quality-tool-contracts";
import { reviewTool as workTool } from "../agent/tools/review_work";
import { reviewTool as sourceTool } from "../agent/tools/inspect_review_source";
import probeTool from "../agent/tools/run_review_probe";
import probeOutputTool from "../agent/tools/read_review_probe";
import { completeReviewWorkInput } from "./fixtures/review-work-contract";
import { probeExecutionIdSchema } from "../src/review/execution-reference";
import { assertStrictToolSchema } from "./fixtures/strict-tool-schema";
import { createGateway } from "@ai-sdk/gateway";
import { replayDynamicTools } from "../node_modules/eve/dist/src/context/build-dynamic-tools.js";
import { buildToolSetFromDefinitions } from "../node_modules/eve/dist/src/harness/tools.js";

const report = {
  axis: "engineering-quality", scope: { claim: "Validate input", dirtyState: "Frozen head", inspectedSupportingContext: [] },
  coverage: { staticOnly: [], unreached: [] }, churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
  probes: [], candidates: [{ title: "Reject invalid input", location: { path: "src/index.ts", line: 1, symbol: null },
    evidence: ["Invalid input bypasses validation"], impact: "Invalid state persists", impactSummary: "Invalid state persists",
    remedy: "Validate at the boundary", staticOnly: true, churn: null, uncertainty: [], evidenceRefs: [] }],
  verifiedClaims: [], limitations: [], specialistChecks: null, requirementChecks: null,
};
const completeWorkInput = { action: { operation: "complete", reviewedEntries: [0], report } };

test("schema-valid reports do not hit an invisible aggregate byte limit during completion", async () => {
  const input = completeReviewWorkInput();
  if (input.action.operation !== "complete") throw new Error("Expected completion fixture");
  input.action.report.verifiedClaims = Array.from({ length: 13 }, (_, index) => `${index}: ${"Measured source context. ".repeat(78)}`);
  expect(Buffer.byteLength(JSON.stringify(input.action.report))).toBeGreaterThan(24_000);
  const wire = z.fromJSONSchema(await asSchema(reviewWorkInputSchema).jsonSchema);
  expect(wire.safeParse(input).success).toBe(true);
  expect(reviewWorkInputSchema.safeParse(input).success).toBe(true);
  const action = input.action;
  expect(() => laneCheckpointContentSchema.parse(reviewWorkCheckpoint(action).checkpoint)).not.toThrow();
});

test("provider-visible source schema rejects the recorded search/path contradiction", async () => {
  const input = { operation: "search", revision: "head", path: "src/config.ts", query: "routing", cursor: null };
  expect(inspectReviewSourceInputSchema.safeParse(input).success).toBe(false);
  const wire = z.fromJSONSchema(await asSchema(inspectReviewSourceInputSchema).jsonSchema);
  expect(wire.safeParse(input).success).toBe(false);
});

test("provider-visible work schema cannot declare completion without a report", async () => {
  const input = { operation: "write", checkpoint: { status: "complete", reviewedEntries: [0], remainingEntries: [], observations: [], nextSteps: [], limitations: [], completedReport: null }, escalation: null };
  expect(reviewWorkInputSchema.safeParse(input).success).toBe(false);
  const wire = z.fromJSONSchema(await asSchema(reviewWorkInputSchema).jsonSchema);
  expect(wire.safeParse(input).success).toBe(false);
});

test("review report and source tools request strict provider enforcement at the SDK boundary", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [], warnings: [], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } }) });
  await generateText({ model: withTaskReasoning(model, "medium"), prompt: "Offline contract inspection", tools: {
    review_work: tool({ inputSchema: reviewWorkInputSchema }),
    inspect_review_source: tool({ inputSchema: inspectReviewSourceInputSchema }),
  } });
  expect(model.doGenerateCalls[0]?.tools?.map(value => "strict" in value ? value.strict : undefined)).toEqual([true, true]);
});

test("every work operation has matching wire and runtime structure and maps to the persisted contract", async () => {
  const compiled = toInputSchema(serializeInputSchema(reviewWorkInputSchema));
  const wire = z.fromJSONSchema(await asSchema(compiled).jsonSchema);
  const progress = { action: { operation: "progress", reviewedEntries: [], remainingEntries: [0], observations: [], nextSteps: ["Run the boundary probe"], limitations: [], escalation: null } };
  const valid = [{ action: { operation: "read" } }, progress, completeWorkInput];
  for (const input of valid) {
    expect(wire.safeParse(input).success).toBe(true);
    expect((await compiled["~standard"].validate(input)).issues).toBeUndefined();
    const parsed = reviewWorkInputSchema.parse(input);
    if (parsed.action.operation !== "read") expect(laneCheckpointContentSchema.safeParse(reviewWorkCheckpoint(parsed.action).checkpoint).success).toBe(true);
  }
  const invalid = [
    { action: { operation: "complete", reviewedEntries: [0] } },
    { action: { operation: "complete", reviewedEntries: [0], report: null } },
    { action: { operation: "complete", reviewedEntries: [0] }, report },
    { action: { ...completeWorkInput.action, checkpoint: report } },
    { action: { ...completeWorkInput.action, remainingEntries: [1] } },
    { action: { ...completeWorkInput.action, escalation: null } },
    { action: { ...progress.action, report } },
    { action: { operation: "read", report } },
    { action: { ...completeWorkInput.action, report: { ...report, candidates: [{ ...report.candidates[0], id: "CR-1", severity: "BLOCKING" }] } } },
    { action: { ...completeWorkInput.action, report: { ...report, candidates: report.candidates.map(({ evidenceRefs: _refs, ...candidate }) => candidate) } } },
    { action: { ...completeWorkInput.action, report: { ...report, candidates: [{ ...report.candidates[0], location: { path: "../escape", line: 1, symbol: null } }] } } },
  ];
  for (const input of invalid) {
    expect(wire.safeParse(input).success).toBe(false);
    expect((await compiled["~standard"].validate(input)).issues?.length).toBeGreaterThan(0);
    expect(reviewWorkInputSchema.safeParse(input).success).toBe(false);
  }
});

test("source operation and path matrices agree before any repository command runs", async () => {
  const compiled = toInputSchema(serializeInputSchema(inspectReviewSourceInputSchema));
  const wire = z.fromJSONSchema(await asSchema(compiled).jsonSchema);
  for (const revision of ["base", "head"] as const) {
    for (const target of [{ operation: "read", path: "src/index.ts" }, { operation: "search", query: "input" }]) {
      const input = { revision, target, cursor: null };
      expect(wire.safeParse(input).success).toBe(true);
      expect((await compiled["~standard"].validate(input)).issues).toBeUndefined();
      const request = sourceInspectionRequest(inspectReviewSourceInputSchema.parse(input));
      expect(request).toMatchObject({ revision, ...target, ...(target.operation === "read" ? { query: null } : { path: null }) });
    }
  }
  for (const target of [
    { operation: "search", query: "input", path: "src/index.ts" },
    { operation: "read", path: "src/index.ts", query: "input" },
    { operation: "search", query: null }, { operation: "read", path: null },
    { operation: "search", query: "first\nsecond" },
    ...["../escape", "/absolute", "src/./index.ts", "src/../index.ts", "src\\index.ts"].map(path => ({ operation: "read", path })),
  ]) {
    const input = { revision: "head", target, cursor: null };
    expect(wire.safeParse(input).success).toBe(false);
    expect((await compiled["~standard"].validate(input)).issues?.length).toBeGreaterThan(0);
    expect(inspectReviewSourceInputSchema.safeParse(input).success).toBe(false);
  }
});

test("strict schemas are object roots with required fields, closed objects and supported nested alternatives", async () => {
  for (const [name, { inputSchema: schema }] of Object.entries(qualityWorkTools)) {
    const wire = await asSchema<unknown>(schema).jsonSchema;
    assertStrictToolSchema(wire, name);
    assertStrictToolSchema(serializeInputSchema(schema), name);
    assertStrictToolSchema(await asSchema(toInputSchema(serializeInputSchema(schema))).jsonSchema, name);
  }
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [], warnings: [], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } }) });
  await generateText({ model: withTaskReasoning(model, "medium"), prompt: "Inspect the hosted tool contracts", tools:
    Object.fromEntries(Object.entries(qualityWorkTools).map(([name, definition]) => [name,
      tool({ ...definition, inputSchema: toInputSchema(serializeInputSchema(definition.inputSchema)) }),
    ])),
  });
  const delivered = model.doGenerateCalls[0]!.tools!;
  expect(delivered).toHaveLength(Object.keys(qualityWorkTools).length);
  for (const definition of delivered) if (definition.type === "function") assertStrictToolSchema(definition.inputSchema, definition.name);
});

test("Eve's durable tool replay and harness deliver the audited contracts to Gateway", async () => {
  const metadata = Object.entries(qualityWorkTools).map(([name, definition]) => ({ name, description: definition.description,
    inputSchema: serializeInputSchema(definition.inputSchema)!, resolverSlug: name, entryKey: "default", callbacks: { execute: { closure: {} } } }));
  const tools = buildToolSetFromDefinitions({ tools: replayDynamicTools(metadata, { sessionId: "offline-schema", scope: "step" }) });
  let requests = 0;
  const provider = createGateway({ apiKey: "offline-fixture", fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    expect(body.tools.map((entry: { name: string }) => entry.name).sort()).toEqual(Object.keys(qualityWorkTools).sort());
    for (const definition of body.tools) {
      assertStrictToolSchema(definition.inputSchema, definition.name);
      if (["review_work", "inspect_review_source"].includes(definition.name)) expect(definition.strict).toBe(true);
      expect(definition.inputSchema).toEqual(asSchema(tools[definition.name]!.inputSchema).jsonSchema);
    }
    return Response.json({ content: [{ type: "text", text: "contract inspected" }], finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } });
  }, { preconnect: () => {} }) })("fixture/model");
  const result = await generateText({ model: withTaskReasoning(provider, "medium"), prompt: "Inspect the final request", tools, maxRetries: 0 });
  expect(result.text).toBe("contract inspected");
  expect(requests).toBe(1);
});

test("UUID evidence IDs retain their accepted values after Eve and SDK schema reconstruction", async () => {
  const idInputs = ["550e8400-e29b-41d4-a716-446655440000", "550E8400-E29B-41D4-A716-446655440000",
    "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "550e8400-e29b-01d4-a716-446655440000", "550e8400-e29b-41d4-7716-446655440000",
    "550e8400e29b41d4a716446655440000", "../escape", "", null, 42];
  for (const id of idInputs) {
    const expected = z.string().uuid().safeParse(id).success;
    expect(probeExecutionIdSchema.safeParse(id).success).toBe(expected);
    for (const [schema, input] of [
      [reviewWorkInputSchema, { action: { ...completeWorkInput.action, report: { ...report,
        candidates: [{ ...report.candidates[0], evidenceRefs: [{ kind: "probe", id }] }] } } }],
      [probeOutputTool.inputSchema, { probeId: "a".repeat(64), executionId: id, stream: "stdout", cursor: null }],
    ] as const) {
      const compiled = toInputSchema(serializeInputSchema(schema));
      const wire = z.fromJSONSchema(await asSchema(compiled).jsonSchema);
      expect(wire.safeParse(input).success).toBe(expected);
      expect((await compiled["~standard"].validate(input)).issues === undefined).toBe(expected);
    }
  }
});

test("the quality evaluator exports the production tool names and exact compiled input contracts", () => {
  const production = { review_work: workTool, inspect_review_source: sourceTool, run_review_probe: probeTool, read_review_probe: probeOutputTool };
  const snapshots = qualityWorkToolSchemas();
  expect(qualityWorkTools).not.toHaveProperty("read_review_probe_output");
  for (const [name, tool] of Object.entries(production)) {
    const snapshot = snapshots.find(item => item.name === name);
    expect(snapshot).toBeDefined();
    const { $schema: _dialect, ...schema } = snapshot!.inputSchema;
    expect(schema as unknown).toEqual(serializeInputSchema(tool.inputSchema));
  }
  expect(qualityWorkTools.read_review_probe.inputSchema.safeParse({ probeId: "a".repeat(64), stream: "stdout", cursor: null }).success).toBe(false);
});
