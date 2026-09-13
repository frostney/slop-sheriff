import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import type { ReviewConfig } from "../config/review-config";
import { laneCompletedReportSchema } from "../review/lane-checkpoint";
import {
  costReportRowSchema,
  summarizeCosts,
  costLifecycleReport,
} from "../telemetry/cost-ledger";
import { reviewReportSchema } from "../review/findings";
import type { ReviewQualityCase } from "./review-quality-corpus";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sourceSchema = z.strictObject({
  path: z.string(),
  revision: sha,
  content: z.string(),
});
export const qualityEvaluationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: z.string(),
  repository: z.string(),
  pullRequest: z.number().int().positive(),
  baseSha: sha,
  headSha: sha,
  previousHeadSha: sha.nullable(),
  claim: z.string(),
  patch: z.string(),
  sources: z.array(sourceSchema),
});
export type QualityEvaluationInput = z.infer<
  typeof qualityEvaluationInputSchema
>;

export const qualityExecutionResultSchema = z.strictObject({
  headSha: sha,
  coverageComplete: z.boolean(),
  assessments: z.array(
    z.strictObject({
      workId: z.string().regex(/^[a-f0-9]{64}$/),
      report: laneCompletedReportSchema,
    }),
  ),
  probes: z.array(
    z.strictObject({
      identity: z.string(),
      command: z.string(),
      outcome: z.enum(["passed", "failed", "unverified"]),
      result: z.string(),
    }),
  ),
  costRows: z.array(costReportRowSchema),
  canonicalReport: reviewReportSchema.nullable().optional(),
  execution: z
    .strictObject({
      transport: z.string(),
      exercised: z.array(z.string()),
      substituted: z.array(z.string()),
      infrastructureCostUsd: z.number().nonnegative().nullable(),
      modelQuality: z.literal("unevaluated"),
    })
    .optional(),
});
export type QualityExecutionResult = z.infer<
  typeof qualityExecutionResultSchema
>;
export class QualityExecutionFailure extends Error {
  constructor(
    message: string,
    readonly result: QualityExecutionResult,
  ) {
    super(message);
    this.name = "QualityExecutionFailure";
  }
}

/** Adapter must invoke production assessment/coverage/probe code, in an isolated exact-revision workspace. */
export interface ReviewQualityExecutor {
  readonly kind: "production-review-lifecycle" | "assessment-only";
  execute(
    input: QualityEvaluationInput,
    config: ReviewConfig,
  ): Promise<QualityExecutionResult>;
}

export function qualityPrompt(input: QualityEvaluationInput): string {
  // Strict projection makes additions such as future findings/current PR bodies fail before billing.
  return JSON.stringify(qualityEvaluationInputSchema.parse(input));
}

/** Read immutable Git objects only. No current PR body, review comments, working tree or later commit messages. */
export function prepareQualityInput(
  testCase: ReviewQualityCase,
  revisionIndex: number,
  repositoryPath: string,
): QualityEvaluationInput {
  const revision = testCase.revisions[revisionIndex];
  if (!revision) throw new Error("Unknown corpus revision");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  for (const value of [revision.base, revision.head]) {
    if (
      git("rev-parse", "--verify", `${sha.parse(value)}^{commit}`).trim() !==
      value
    )
      throw new Error("Corpus Git revision mismatch");
  }
  const mergeBase = git("merge-base", revision.base, revision.head).trim();
  const paths = git("diff", "--name-only", "-z", mergeBase, revision.head)
    .split("\0")
    .filter(Boolean);
  const sources = paths
    .filter((path) =>
      /(?:^|\/)(?:AGENTS|README|CONTRIBUTING|CONTEXT|DOD|DEFINITION[-_]OF[-_]DONE)\.md$/i.test(
        path,
      ),
    )
    .flatMap((path) => {
      try {
        return [
          {
            path,
            revision: revision.base,
            content: git("show", `${revision.base}:${path}`),
          },
        ];
      } catch {
        return [];
      }
    });
  return qualityEvaluationInputSchema.parse({
    schemaVersion: 1,
    caseId: testCase.id,
    repository: testCase.repository,
    pullRequest: testCase.pullRequest,
    baseSha: revision.base,
    headSha: revision.head,
    previousHeadSha: testCase.revisions[revisionIndex - 1]?.head ?? null,
    claim: testCase.claim,
    patch: git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--full-index",
      mergeBase,
      revision.head,
    ),
    sources,
  });
}

export function measureQualityInput(input: QualityEvaluationInput) {
  const prompt = qualityPrompt(input);
  return {
    inputDigest: digest(prompt),
    bytes: Buffer.byteLength(prompt),
    textTokens: getEncoding("o200k_base").encode(prompt).length,
    tokenizer: "o200k_base",
    providerInputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
  };
}

const rateSchema = z.object({
  id: z.string(),
  pricing: z.object({
    input: z.coerce.number().nonnegative(),
    output: z.coerce.number().nonnegative(),
    input_cache_read: z.coerce.number().nonnegative().optional(),
    input_tiers: z
      .array(
        z.object({
          cost: z.coerce.number().nonnegative(),
          min: z.number(),
          max: z.number().optional(),
        }),
      )
      .optional(),
  }),
});
export function projectQualityInputCost(
  rawModel: unknown,
  inputTokens: number,
) {
  const model = rateSchema.parse(rawModel);
  const tier = model.pricing.input_tiers?.find(
    (t) => inputTokens >= t.min && (t.max === undefined || inputTokens < t.max),
  );
  return {
    model: model.id,
    uncachedTextInputProjectionUsd:
      inputTokens * (tier?.cost ?? model.pricing.input),
    totalProjectionUsd: null,
    outputTokens: null,
    cacheReadTokens: null,
    assumptions:
      "Text-token estimate only. Tool schemas, provider tokenization, reasoning output, retries and cache behavior are not predicted.",
  };
}

/** Sensitivity is arithmetic for stated assumptions, never predicted model output or a runtime allowance. */
export function projectQualityProtocolCost(
  rawModel: unknown,
  knownStepInputTokens: readonly number[],
) {
  const model = rateSchema.parse(rawModel);
  const knownProtocolInputProjectionUsd = knownStepInputTokens.reduce(
    (sum, tokens) =>
      sum +
      projectQualityInputCost(rawModel, tokens).uncachedTextInputProjectionUsd,
    0,
  );
  return {
    model: model.id,
    knownProtocolInputProjectionUsd,
    outputTokens: null,
    totalLifecycleCostUsd: null,
    outputSensitivity: [1_000, 4_000].map((assumedOutputTokens) => ({
      assumedOutputTokens,
      knownInputPlusAssumedOutputUsd:
        knownProtocolInputProjectionUsd +
        assumedOutputTokens * model.pricing.output,
    })),
    additionalUncachedInputPer10kUsd: model.pricing.input * 10_000,
    additionalOutputPer10kUsd: model.pricing.output * 10_000,
    excludes: [
      "generated report/tool-call replay as input",
      "investigation output and additional calls",
      "revalidation not yet selected",
      "retries/fallback/escalation",
      "provider framing and actual tokenization",
      "infrastructure",
    ],
  };
}

/** All failed attempts remain visible; unadjudicated quality and unresolved billing never become zero. */
export async function evaluateQualityLifecycle(
  inputs: readonly QualityEvaluationInput[],
  config: ReviewConfig,
  executor: ReviewQualityExecutor,
) {
  const runs = [];
  const allCosts: z.infer<typeof costReportRowSchema>[] = [];
  for (const input of inputs) {
    qualityPrompt(input);
    const startedAt = Date.now();
    try {
      const result = qualityExecutionResultSchema.parse(
        await executor.execute(input, config),
      );
      if (result.headSha !== input.headSha)
        throw new Error("Evaluation result belongs to another revision");
      if (
        result.costRows.some(
          (row) =>
            row.repository !== input.repository ||
            row.pullRequest !== input.pullRequest ||
            row.headSha !== input.headSha,
        )
      )
        throw new Error("Evaluation costs belong to another review");
      allCosts.push(...result.costRows);
      runs.push({
        elapsedMs: Date.now() - startedAt,
        status: "completed",
        ...result,
      });
    } catch (error) {
      const partial =
        error instanceof QualityExecutionFailure
          ? qualityExecutionResultSchema.parse(error.result)
          : null;
      const matching =
        partial !== null &&
        partial.headSha === input.headSha &&
        partial.costRows.every(
          (row) =>
            row.repository === input.repository &&
            row.pullRequest === input.pullRequest &&
            row.headSha === input.headSha,
        );
      if (matching) allCosts.push(...partial.costRows);
      runs.push({
        ...(matching ? partial : {}),
        headSha: input.headSha,
        elapsedMs: Date.now() - startedAt,
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Evaluation execution failed",
        billingUnknown: !matching,
      });
      break;
    }
  }
  const costs = summarizeCosts(allCosts);
  const complete =
    inputs.length > 0 &&
    runs.length === inputs.length &&
    runs.every(
      (run) =>
        run.status === "completed" &&
        "coverageComplete" in run &&
        run.coverageComplete &&
        run.assessments &&
        run.assessments.length > 0 &&
        run.assessments.every(
          (assessment) => assessment.report.coverage.unreached.length === 0,
        ) &&
        run.probes &&
        run.probes.every((probe) => probe.outcome !== "unverified"),
    );
  const totalCostUsd =
    runs.some((run) => "billingUnknown" in run && run.billingUnknown) ||
    allCosts.length === 0
      ? null
      : costs.totalCostUsd;
  const infrastructureKnown =
    runs.length > 0 &&
    runs.every(
      (run) =>
        "execution" in run && run.execution?.infrastructureCostUsd != null,
    );
  const infrastructureCostUsd = infrastructureKnown
    ? runs.reduce(
        (total, run) =>
          total +
          ("execution" in run
            ? (run.execution?.infrastructureCostUsd ?? 0)
            : 0),
        0,
      )
    : null;
  const lifecycleCostUsd =
    totalCostUsd !== null && infrastructureCostUsd !== null
      ? totalCostUsd + infrastructureCostUsd
      : null;
  return {
    kind: executor.kind,
    runs,
    infrastructureCostUsd,
    lifecycleCostUsd,
    costs: { ...costs, totalCostUsd },
    costLifecycle: costLifecycleReport(allCosts),
    coverageComplete: complete,
    quality: "unknown-pending-adjudication",
    routineLifecycleTargetUsd: 1,
    targetAssessment:
      !complete ||
      executor.kind !== "production-review-lifecycle" ||
      lifecycleCostUsd === null
        ? "unknown"
        : lifecycleCostUsd < 1
          ? "within-measured-target"
          : "above-measured-target",
  };
}
