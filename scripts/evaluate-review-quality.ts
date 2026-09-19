import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFile } from "node:fs/promises";
import { parseReviewConfig } from "../src/config/review-config";
import {
  reviewQualityCorpus,
  reviewQualityStressCorpus,
} from "../src/evaluation/review-quality-corpus";
import { prepareQualityInvocationPlan } from "../src/evaluation/quality-workspace";
import {
  createQualityControlRepository,
  qualityControlLabels,
} from "../src/evaluation/quality-controls";
import {
  evaluateQualityLifecycle,
  measureQualityInput,
  prepareQualityInput,
  projectQualityProtocolCost,
  type ReviewQualityExecutor,
} from "../src/evaluation/review-quality";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    case: { type: "string" },
    repository: { type: "string" },
    config: { type: "string" },
    catalog: { type: "string" },
    executor: { type: "string" },
    output: { type: "string" },
    "real-model": { type: "boolean", default: false },
  },
});

if (!values.case && !values["real-model"]) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        quality: "unknown-pending-adjudication",
        routineLifecycleTargetUsd: 1,
        cases: [
          ...reviewQualityCorpus.map((c) => ({
            ...c,
            cohort: "routine",
            url: `https://github.com/${c.repository}/pull/${c.pullRequest}`,
          })),
          ...reviewQualityStressCorpus.map((c) => ({
            ...c,
            cohort: "stress",
            url: `https://github.com/${c.repository}/pull/${c.pullRequest}`,
          })),
        ],
        controls: {
          id: "seeded-port-boundary",
          cohort: "routine-seeded-control",
          labels: qualityControlLabels,
        },
        next: "Supply --case ID --repository LOCAL_GIT_CHECKOUT to measure exact inputs. No model calls occur without --real-model. The built-in executor is used only after opt-in.",
      },
      null,
      2,
    ),
  );
} else {
  const controls =
    values.case === "seeded-port-boundary"
      ? await createQualityControlRepository()
      : null;
  try {
    const testCase =
      controls?.testCase ??
      [...reviewQualityCorpus, ...reviewQualityStressCorpus].find(
        (c) => c.id === values.case,
      );
    const repositoryPath = controls?.root ?? values.repository;
    if (!testCase || !repositoryPath)
      throw new Error(
        "Supply a known --case and local --repository containing all exact revisions",
      );
    const config = parseReviewConfig(
      values.config ? await Bun.file(values.config).text() : null,
    );
    const inputs = testCase.revisions.map((_, index) =>
      prepareQualityInput(testCase, index, repositoryPath),
    );
    const catalog: { data: unknown[] } = values.catalog
      ? await Bun.file(values.catalog).json()
      : await fetch("https://ai-gateway.vercel.sh/v1/models").then(
          (response) => {
            if (!response.ok)
              throw new Error("Gateway model catalog unavailable");
            return response.json();
          },
        );
    const invocationPlans = await Promise.all(
      inputs.map((input) =>
        prepareQualityInvocationPlan(repositoryPath, input, config),
      ),
    );
    const catalogModel = (id: string) => {
      const record = catalog.data.find(
        (raw) =>
          typeof raw === "object" &&
          raw !== null &&
          "id" in raw &&
          raw.id === id,
      );
      if (!record)
        throw new Error(
          `Configured model is absent from current catalog: ${id}`,
        );
      return record;
    };
    const projectedPlans = invocationPlans.map((plan) => ({
      ...plan,
      workUnits: plan.workUnits.map((unit) => ({
        ...unit,
        projections: unit.models.map((model) =>
          projectQualityProtocolCost(
            catalogModel(model),
            unit.knownStepInputTokens,
          ),
        ),
      })),
      adjudication: {
        ...plan.adjudication,
        projections: plan.adjudication.models.map((model) =>
          projectQualityProtocolCost(catalogModel(model), [
            plan.adjudication.knownInstructionTokens +
              plan.adjudication.knownToolSchemaTokens,
          ]),
        ),
      },
    }));
    const primaryProjections = projectedPlans.flatMap((plan) => [
      ...plan.workUnits.map((unit) => unit.projections[0]!),
      plan.adjudication.projections[0]!,
    ]);
    const economics = {
      knownProtocolInputProjectionUsd: primaryProjections.reduce(
        (sum, item) => sum + item.knownProtocolInputProjectionUsd,
        0,
      ),
      outputSensitivity: [0, 1].map((index) => ({
        assumedOutputTokensPerAssessmentAndAdjudication:
          primaryProjections[0]?.outputSensitivity[index]?.assumedOutputTokens,
        knownInputPlusAssumedOutputUsd: primaryProjections.reduce(
          (sum, item) =>
            sum +
            (item.outputSensitivity[index]?.knownInputPlusAssumedOutputUsd ??
              0),
          0,
        ),
      })),
      totalLifecycleCostUsd: null,
      assumedReuse: false,
      note: "All initial and update units are included without assumed reuse. These subtotals omit investigation/revalidation, generated input replay, extra calls, provider differences and infrastructure. Output sensitivities are stated scenarios, not measured output or a spending limit.",
    };
    const plan = {
      mode: "dry-run",
      caseId: testCase.id,
      cohort: reviewQualityStressCorpus.some((c) => c.id === testCase.id)
        ? "stress"
        : controls
          ? "routine-seeded-control"
          : "routine",
      quality: "unknown-pending-adjudication",
      invocationPlans: projectedPlans,
      economics,
      inputs: inputs.map((input) => ({
        headSha: input.headSha,
        baseSha: input.baseSha,
        ...measureQualityInput(input),
      })),
      note: "Per-unit projections derive from actual prepared packets, production dispatch, shared tool schemas and turn policy. Exact model output, investigative context and lifecycle totals remain unknown.",
    };
    if (!values["real-model"]) console.log(JSON.stringify(plan, null, 2));
    else {
      if (!values.output)
        throw new Error(
          "Paid execution requires an explicit --output evidence file",
        );
      // Never import executable adapter code during dry runs.
      const module = await import(
        values.executor
          ? pathToFileURL(resolve(values.executor)).href
          : new URL(
              "../src/evaluation/production-review-executor.ts",
              import.meta.url,
            ).href
      );
      const executor: ReviewQualityExecutor =
        typeof module.createExecutor === "function"
          ? module.createExecutor({
              repositoryPath,
              record: (event: unknown) =>
                appendFile(
                  `${values.output}.events.jsonl`,
                  `${JSON.stringify(event)}\n`,
                ),
            })
          : module.default;
      if (
        !executor ||
        !["production-review-lifecycle", "assessment-only"].includes(
          executor.kind,
        ) ||
        typeof executor.execute !== "function"
      )
        throw new Error("Invalid review quality executor");
      await Bun.write(
        values.output,
        JSON.stringify(
          { plan, status: "starting", billingUnknown: true },
          null,
          2,
        ),
      );
      const result = await evaluateQualityLifecycle(inputs, config, executor);
      await Bun.write(values.output, JSON.stringify({ plan, result }, null, 2));
      console.log(
        JSON.stringify({ output: resolve(values.output), ...result }, null, 2),
      );
      if (!result.coverageComplete) process.exitCode = 1;
    }
  } finally {
    await controls?.cleanup();
  }
}
