import { describe, expect, test } from "bun:test";
import { generateText, stepCountIs, tool } from "ai";
import {
  MockLanguageModelV4,
  MockProviderV4,
} from "ai/test";
import { mockModel } from "eve/evals";
import {
  assembleReviewReportInputSchema,
  recordReviewRevalidationInputSchema,
} from "../src/review/tool-inputs";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const validFinding = {
  category: "QUALITY" as const,
  severity: "IMPORTANT" as const,
  title: "Reject stale review fields before execution",
  location: { path: "src/review.ts", line: 1, symbol: null },
  evidence: ["The model-facing schema rejects application-owned status."],
  impact: "Invalid review output cannot reach application state.",
  requirementIds: [],
  introduction: "The recorded publication path can replay the same operation without reusing its identity, so a retry exposes duplicate output to readers even though the original work already finished successfully.",
  principle: "Retries must preserve the recorded publication identity.",
  risk: "A retry can duplicate output for every reader of the affected review.",
  impactSummary: "Invalid review output cannot reach application state.",
  remedy: "Keep the provider-visible schema aligned with the tool boundary.",
  staticOnly: true,
  churn: null,
};

const validDraft = {
  actionSummary: "Validated the report publication contract.", additionalConcerns: [],
  scope: { claim: "Validate the review contract.", dirtyState: "clean" },
  coverage: { staticOnly: [], unreached: [] },
  churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
  probes: [],
  freshFindings: [validFinding],
  verifiedClaims: [],
  limitations: [],
};

describe("official AI SDK and Eve mocks", () => {
  test("sends the canonical revalidation finding contract to the provider", async () => {
    const languageModel = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    });
    const provider = new MockProviderV4({
      languageModels: { contract: languageModel },
    });

    await generateText({
      model: provider.languageModel("contract"),
      prompt: "Inspect the available review contract.",
      tools: {
        record_review_revalidation: tool({
          inputSchema: recordReviewRevalidationInputSchema,
        }),
      },
    });

    expect(languageModel.doGenerateCalls[0]?.tools?.[0]).toMatchObject({
      type: "function",
      name: "record_review_revalidation",
      inputSchema: {
        additionalProperties: false,
        required: ["findings"],
        properties: {
          findings: {
            type: "array",
            items: {
              oneOf: expect.any(Array),
            },
          },
        },
      },
    });
  });

  test("runs a valid canonical report tool loop without a provider call", async () => {
    let executedDraft: unknown = null;
    const model = mockModel(({ toolResults }) =>
      toolResults.length > 0
        ? "report accepted"
        : {
            toolCalls: [
              {
                name: "assemble_review_report",
                input: { draft: validDraft },
              },
            ],
          },
    );

    const result = await generateText({
      model,
      prompt: "Assemble the canonical review report.",
      stopWhen: stepCountIs(2),
      tools: {
        assemble_review_report: tool({
          inputSchema: assembleReviewReportInputSchema,
          execute({ draft }) {
            executedDraft = draft;
            return { accepted: true };
          },
        }),
      },
    });

    expect(result.text).toBe("report accepted");
    expect(executedDraft).toEqual(validDraft);
    expect(result.steps).toHaveLength(2);
  });

  test("rejects stale application-owned finding fields before tool execution", async () => {
    let executed = false;
    const model = mockModel(() => ({
      toolCalls: [
        {
          name: "assemble_review_report",
          input: {
            draft: {
              ...validDraft,
              freshFindings: [{ ...validFinding, status: "open" }],
            },
          },
        },
      ],
    }));

    const result = await generateText({
      model,
      prompt: "Attempt to assemble a stale report.",
      stopWhen: stepCountIs(1),
      tools: {
        assemble_review_report: tool({
          inputSchema: assembleReviewReportInputSchema,
          execute() {
            executed = true;
            return { accepted: true };
          },
        }),
      },
    });

    expect(executed).toBeFalse();
    expect(result.toolCalls[0]).toMatchObject({
      dynamic: true,
      error: { name: "AI_InvalidToolInputError" },
      invalid: true,
      toolName: "assemble_review_report",
    });
    expect(result.toolResults).toEqual([]);
  });
});
