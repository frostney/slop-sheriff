import { describe, expect, test } from "bun:test";
import { asSchema, generateText, stepCountIs, tool } from "ai";
import { mockModel } from "eve/evals";
import { z } from "zod";
import { findingIdentity } from "../src/review/finding-identity";
import { reviewFindingDraftSchema, reviewFindingSchema } from "../src/review/findings";
import {
  assembleCanonicalReviewReport, beginReportAssembly, recordRevalidationResults,
  reportAssemblyStateSchema,
} from "../src/review/report-assembly";
import { assembleReviewReportInputSchema, recordReviewRevalidationInputSchema } from "../src/review/tool-inputs";
import { reviewLaneCheckpointInputSchema } from "../agent/tools/review_lane_checkpoint";
import { laneCompletedReportSchema, laneCheckpointSchema } from "../src/review/lane-checkpoint";
import { findingBody } from "../src/github/review-presentation";
import { findingImpactSummary } from "../src/github/deterministic-presentation";

const draftFinding = {
  severity: "IMPORTANT" as const, category: "QUALITY" as const,
  title: "A retry republishes the finding",
  location: { path: "src/review.ts", line: 1, symbol: null },
  evidence: ["The same operation was published twice."],
  impact: "A retry produces duplicate comments. ".repeat(20),
  requirementIds: [],
  introduction: "The recorded publication path can replay the same operation without reusing its identity, so a retry exposes duplicate output to readers even though the original work already finished successfully.",
  principle: "Retries must preserve the recorded publication identity.",
  risk: "A retry can duplicate output for every reader of the affected review.",
  impactSummary: "A retry produces duplicate comments.",
  remedy: "Reuse the recorded publication identity.", staticOnly: true, churn: null,
};
const draft = {
  actionSummary: "Reviewed the affected publication paths and retained the observed evidence.", additionalConcerns: [],
  scope: { claim: "Preserve publication identity", dirtyState: "clean" },
  coverage: { staticOnly: [], unreached: [] },
  churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
  probes: [], freshFindings: [draftFinding], verifiedClaims: [], limitations: [],
};
const identity = {
  executionRevision: "review-report-v2" as const,
  repositoryId: "R_test", pullRequest: 1,
  baseSha: "1".repeat(40), headSha: "2".repeat(40), patchFingerprint: "3".repeat(64),
  planKind: "full" as const, baselineHead: null,
  reviewPaths: ["src/review.ts"], activeAxes: ["engineering-quality" as const], selectedFindingIds: [],
};
const generatedAt = "2026-09-10T12:00:00.000Z";
const categoryChurn = {
  granularity: "file", window: "90 days", touches: 2, linesAdded: 1, linesDeleted: 1, coSignals: [],
};

describe("bounded impact contract", () => {
  test("requires the summary in every provider-visible fresh variant and preserves optional legacy revalidation", async () => {
    const fresh = await asSchema(assembleReviewReportInputSchema).jsonSchema;
    const variants = z.object({ properties: z.object({ draft: z.object({ properties: z.object({
      freshFindings: z.object({ items: z.object({ oneOf: z.array(z.object({
        required: z.array(z.string()), properties: z.record(z.string(), z.unknown()),
      })) }) }),
    }) }) }) }).parse(fresh).properties.draft.properties.freshFindings.items.oneOf;
    expect(variants).toHaveLength(4);
    for (const variant of variants) {
      for (const field of ["impactSummary", "introduction", "principle", "risk", "requirementIds"]) expect(variant.required).toContain(field);
      for (const field of ["id", "status", "dismissal"]) expect(variant.properties).not.toHaveProperty(field);
      expect(variant.properties.impactSummary).toMatchObject({ type: "string", minLength: 1, maxLength: 300 });
      expect(variant.properties.impact).not.toHaveProperty("maxLength");
    }
    const revalidation = await asSchema(recordReviewRevalidationInputSchema).jsonSchema;
    expect(revalidation).not.toHaveProperty("properties.findings.items.oneOf.0.properties.dismissal");
    expect(revalidation).toHaveProperty("properties.findings.items.oneOf.0.properties.impactSummary.maxLength", 300);
    for (const category of ["CLAIM", "QUALITY", "ARCHITECTURE_RISK", "DISCOVERABILITY"] as const) {
      const candidate = { ...draftFinding, category, churn: category === "ARCHITECTURE_RISK" ? categoryChurn : null };
      for (const impactSummary of ["x", "x".repeat(300)]) {
        const parsed = reviewFindingDraftSchema.parse({ ...candidate, impactSummary });
        const state = assembleCanonicalReviewReport({ state: beginReportAssembly(identity), priorReport: null,
          generatedAt, draft: { ...draft, freshFindings: [parsed] } });
        expect(state.report?.findings[0]).toMatchObject({ impactSummary, impact: candidate.impact });
      }
      for (const impactSummary of [undefined, "", "x".repeat(301)]) {
        expect(reviewFindingDraftSchema.safeParse({ ...candidate, impactSummary }).success).toBeFalse();
      }
      const { impactSummary: _summary, ...legacy } = candidate;
      expect(reviewFindingSchema.parse({ ...legacy, id: "CR-1", status: "open" }).impact).toBe(candidate.impact);
    }
  });

  test("carries lane summaries to canonical reports while accepting old checkpoints", async () => {
    const { category: _category, severity: _severity, requirementIds: _requirementIds, ...evidence } = draftFinding;
    const report = {
      axis: "engineering-quality", scope: { ...draft.scope, inspectedSupportingContext: [] },
      coverage: draft.coverage, churn: draft.churn, probes: [],
      candidates: [{ ...evidence, uncertainty: [] }], verifiedClaims: [], limitations: [],
      specialistChecks: null, requirementChecks: null,
    };
    const checkpoint = {
      status: "complete", reviewedEntries: [0], remainingEntries: [], observations: [], nextSteps: [], limitations: [],
      completedReport: report,
    };
    const parsed = reviewLaneCheckpointInputSchema.parse({ operation: "write", axis: "engineering-quality", checkpoint });
    expect(parsed.checkpoint?.completedReport?.candidates[0]?.impactSummary).toBe(evidence.impactSummary);
    const { uncertainty: _uncertainty, ...mappedEvidence } = parsed.checkpoint!.completedReport!.candidates[0]!;
    const assembled = assembleCanonicalReviewReport({ state: beginReportAssembly(identity), priorReport: null, generatedAt,
      draft: { ...draft, freshFindings: [{ ...mappedEvidence, requirementIds: [], category: "QUALITY", severity: "IMPORTANT" }] } });
    expect(assembled.report?.findings[0]).toMatchObject({ impact: evidence.impact, impactSummary: evidence.impactSummary });
    const schema = await asSchema(reviewLaneCheckpointInputSchema).jsonSchema;
    expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.candidates.items.properties.impactSummary.maxLength", 300);
    expect(reviewLaneCheckpointInputSchema.safeParse({ operation: "write", axis: "engineering-quality", checkpoint: {
      ...checkpoint, completedReport: { ...report, candidates: [{ ...evidence, impactSummary: "x".repeat(301), uncertainty: [] }] },
    } }).success).toBeFalse();
    const { impactSummary: _summary, ...legacyEvidence } = evidence;
    const legacyReport = { ...report, candidates: [{ ...legacyEvidence, uncertainty: [] }] };
    expect(laneCompletedReportSchema.parse(legacyReport).candidates[0]).not.toHaveProperty("impactSummary");
    expect(laneCheckpointSchema.parse({ ...checkpoint, completedReport: legacyReport, schemaVersion: 3,
      axis: report.axis, baseSha: identity.baseSha, headSha: identity.headSha, patchFingerprint: identity.patchFingerprint,
      evidenceDigest: "4".repeat(64), revision: 1,
    }).completedReport?.candidates[0]?.impact).toBe(evidence.impact);
    expect(reviewLaneCheckpointInputSchema.safeParse({ operation: "write", axis: report.axis,
      checkpoint: { ...checkpoint, completedReport: legacyReport },
    }).success).toBeFalse();
  });

  test("preserves old semantic identity, revalidation and immutable assembly retries", () => {
    const first = assembleCanonicalReviewReport({ state: beginReportAssembly(identity), priorReport: null, generatedAt, draft });
    const { impactSummary: _summary, ...legacy } = first.report!.findings[0]!;
    const summarized = { ...legacy, impactSummary: "Different visible wording" };
    expect(findingIdentity(summarized)).toBe(findingIdentity(legacy));
    const priorReport = { ...first.report!, findings: [legacy] };
    const state = beginReportAssembly({ ...identity, headSha: "5".repeat(40), planKind: "delta",
      baselineHead: identity.headSha, selectedFindingIds: [legacy.id] });
    const revalidated = recordRevalidationResults(state, [{ ...legacy, impactSummary: "Revalidated consequence" }]);
    expect(recordRevalidationResults(revalidated, revalidated.revalidatedFindings)).toEqual(revalidated);
    const assembled = assembleCanonicalReviewReport({ state: revalidated, priorReport, generatedAt,
      draft: { ...draft, freshFindings: [{ ...draftFinding, impactSummary: "A duplicate with a different summary" }] } });
    expect(assembled.report?.findings).toHaveLength(1);
    expect(assembled.report?.findings[0]).toMatchObject({ id: legacy.id, impact: legacy.impact, impactSummary: "Revalidated consequence" });
    expect(assembleCanonicalReviewReport({ state: assembled, priorReport, generatedAt, draft: { invalid: true } })).toEqual(assembled);
    expect(reportAssemblyStateSchema.parse({ ...first, report: priorReport }).report?.findings[0]).not.toHaveProperty("impactSummary");
    const oldRevalidated = recordRevalidationResults(state, [legacy]);
    expect(oldRevalidated.revalidatedFindings[0]).not.toHaveProperty("impactSummary");
  });

  test("repairs an oversized model summary before any assembly executes using official Eve mocks", async () => {
    let attempts = 0;
    let executions = 0;
    const result = await generateText({
      model: mockModel(() => {
        attempts += 1;
        return attempts > 2 ? "accepted" : { toolCalls: [{ name: "assemble_review_report", input: {
          draft: { ...draft, freshFindings: [{ ...draftFinding, impactSummary: attempts === 1 ? "x".repeat(301) : "A retry duplicates comments." }] },
        } }] };
      }),
      prompt: "Assemble the reviewed finding.", stopWhen: stepCountIs(3),
      tools: { assemble_review_report: tool({ inputSchema: assembleReviewReportInputSchema, execute({ draft: input }) {
        executions += 1;
        return assembleCanonicalReviewReport({ state: beginReportAssembly(identity), priorReport: null, generatedAt, draft: input });
      } }) },
    });
    expect(result.steps[0]?.toolCalls[0]).toMatchObject({ invalid: true, error: { name: "AI_InvalidToolInputError" } });
    expect(executions).toBe(1);
    expect(result.text).toBe("accepted");
  });

  test("ends with the escaped bounded impact and omits the stored full analysis", () => {
    const full = `</details><script>alert('x')</script>\n\n${"e\u0301🤠".repeat(200)}\n\nThe retry duplicates comments.`;
    const finding = reviewFindingSchema.parse({ ...draftFinding, impact: full, id: "CR-1", status: "open" });
    const body = findingBody({ ...finding, impactSummary: "<img src=x> & **consequence**" });
    expect(body).toContain("Impact: &lt;img src=x&gt; &amp; \\*\\*consequence\\*\\*");
    expect(body).toContain("<summary>Evidence and recommended change</summary>");
    expect(body).not.toContain("Smallest remedy");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("e\u0301🤠".repeat(200));
    expect(findingBody(finding, "line", false)).not.toContain("rundown");
    for (const impact of ["🤠".repeat(200), "e\u0301".repeat(200), "x".repeat(298) + "👩‍👩‍👧‍👦more", "x".repeat(300)]) {
      const legacy = { ...finding, impact, impactSummary: undefined };
      const summary = findingImpactSummary(legacy);
      expect(summary.length).toBeLessThanOrEqual(300);
      expect(Buffer.from(summary).toString("utf8")).toBe(summary);
      const excerpt = summary.endsWith("…") ? summary.slice(0, -1) : summary;
      const boundaries = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(impact)]
        .map(({ index, segment }) => index + segment.length);
      expect(boundaries).toContain(excerpt.length);
      expect(findingBody(legacy)).toBe(findingBody(legacy));
    }
  });
});
