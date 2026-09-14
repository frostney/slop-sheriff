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
  const wire = z.fromJSONSchema(await asSchema(reviewWorkInputSchema).jsonSchema);
  const compiled = toInputSchema(serializeInputSchema(reviewWorkInputSchema));
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
  const wire = z.fromJSONSchema(await asSchema(inspectReviewSourceInputSchema).jsonSchema);
  const compiled = toInputSchema(serializeInputSchema(inspectReviewSourceInputSchema));
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
  function inspect(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(inspect); return; }
    const value = node as Record<string, unknown>;
    expect(value).not.toHaveProperty("oneOf");
    if (value.type === "object") {
      expect(value.additionalProperties).toBe(false);
      expect([...(value.required as string[] ?? [])].sort()).toEqual(Object.keys(value.properties as object ?? {}).sort());
    }
    Object.values(value).forEach(inspect);
  }
  for (const schema of [reviewWorkInputSchema, inspectReviewSourceInputSchema]) {
    const wire = await asSchema<unknown>(schema).jsonSchema;
    expect(wire.type).toBe("object");
    expect(wire).not.toHaveProperty("anyOf");
    inspect(wire);
    inspect(serializeInputSchema(schema));
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
