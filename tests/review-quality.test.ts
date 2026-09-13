import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseReviewConfig } from "../src/config/review-config";
import { reviewQualityCorpus } from "../src/evaluation/review-quality-corpus";
import {
  evaluateQualityLifecycle,
  measureQualityInput,
  projectQualityInputCost,
  projectQualityProtocolCost,
  qualityPrompt,
  type QualityEvaluationInput,
} from "../src/evaluation/review-quality";

const input: QualityEvaluationInput = {
  schemaVersion: 1,
  caseId: "fixture",
  repository: "owner/repo",
  pullRequest: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  previousHeadSha: null,
  claim: "Preserve the public result",
  patch: "+return value;",
  sources: [],
};

test("corpus includes source fixes, docs, tests, dependency changes and real successive revisions", () => {
  expect(reviewQualityCorpus).toHaveLength(6);
  expect(
    new Set(reviewQualityCorpus.flatMap((c) => [...c.languages])).size,
  ).toBeGreaterThan(2);
  expect(reviewQualityCorpus.some((c) => c.kind === "docs-only")).toBeTrue();
  expect(
    reviewQualityCorpus.filter((c) => c.revisions.length > 1),
  ).toHaveLength(4);
  expect(
    reviewQualityCorpus.every((c) =>
      c.revisions.every(
        (r) => /^[a-f0-9]{40}$/.test(r.base) && /^[a-f0-9]{40}$/.test(r.head),
      ),
    ),
  ).toBeTrue();
});

test("later review labels and current PR bodies cannot enter strict model input", () => {
  expect(() =>
    qualityPrompt({
      ...input,
      futureFinding: "answer",
    } as QualityEvaluationInput),
  ).toThrow();
  expect(() =>
    qualityPrompt({
      ...input,
      currentPrBody: "fixed by next commit",
    } as QualityEvaluationInput),
  ).toThrow();
  const measured = measureQualityInput(input);
  expect(measured.bytes).toBe(Buffer.byteLength(qualityPrompt(input)));
  expect(measured.textTokens).toBeGreaterThan(0);
  expect(measured.outputTokens).toBeNull();
  expect(measured.providerInputTokens).toBeNull();
});

test("input projections honor catalog tiers while keeping lifecycle cost unknown", () => {
  const projection = projectQualityInputCost(
    {
      id: "provider/model",
      pricing: {
        input: "0.000001",
        output: "0.000002",
        input_tiers: [
          { min: 0, max: 100, cost: "0.000001" },
          { min: 100, cost: "0.000003" },
        ],
      },
    },
    200,
  );
  expect(projection.uncachedTextInputProjectionUsd).toBeCloseTo(0.0006);
  expect(projection.totalProjectionUsd).toBeNull();
});

test("component-only success cannot certify lifecycle economics or unadjudicated quality", async () => {
  const result = await evaluateQualityLifecycle(
    [input],
    parseReviewConfig(null),
    {
      kind: "assessment-only",
      execute: async () => ({
        headSha: input.headSha,
        coverageComplete: true,
        assessments: [],
        probes: [],
        costRows: [],
      }),
    },
  );
  expect(result.targetAssessment).toBe("unknown");
  expect(result.quality).toBe("unknown-pending-adjudication");
});

test("wrong-head results and failed executions stay incomplete with unknown billing", async () => {
  let calls = 0;
  const result = await evaluateQualityLifecycle(
    [input, input],
    parseReviewConfig(null),
    {
      kind: "production-review-lifecycle",
      execute: async () => {
        calls += 1;
        return {
          headSha: "c".repeat(40),
          coverageComplete: true,
          assessments: [],
          probes: [],
          costRows: [],
        };
      },
    },
  );
  expect(calls).toBe(1);
  expect(result.coverageComplete).toBeFalse();
  expect(result.costs.totalCostUsd).toBeNull();
  expect(result.targetAssessment).toBe("unknown");
});

test("CLI dry runs do not import an executor and paid mode requires explicit corpus input", () => {
  const script = fileURLToPath(
    new URL("../scripts/evaluate-review-quality.ts", import.meta.url),
  );
  const dry = Bun.spawnSync([
    process.execPath,
    script,
    "--executor",
    "/missing-must-not-import.ts",
  ]);
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout.toString()).mode).toBe("dry-run");
  const paid = Bun.spawnSync([
    process.execPath,
    script,
    "--real-model",
    "--executor",
    "/missing-must-not-import.ts",
  ]);
  expect(paid.exitCode).not.toBe(0);
  expect(paid.stderr.toString()).toContain("Supply a known --case");
});

test("protocol projections price actual step inputs separately and keep output scenarios explicit", () => {
  const projection = projectQualityProtocolCost(
    {
      id: "provider/model",
      pricing: {
        input: "0.000001",
        output: "0.000002",
        input_tiers: [
          { min: 0, max: 100, cost: "0.000001" },
          { min: 100, cost: "0.000003" },
        ],
      },
    },
    [80, 80, 80],
  );
  expect(projection.knownProtocolInputProjectionUsd).toBeCloseTo(0.00024);
  expect(projection.outputSensitivity[0]).toEqual({
    assumedOutputTokens: 1000,
    knownInputPlusAssumedOutputUsd: 0.00224,
  });
  expect(projection.outputTokens).toBeNull();
  expect(projection.totalLifecycleCostUsd).toBeNull();
});
