import { selectReviewAxes } from "../src/review/axis-selection";
import { describe, expect, test } from "bun:test";
import { decodeReviewState, encodeReviewState } from "../src/github/review-state";
import { pendingPublicationRetry } from "../src/github/publication";
import type { ReviewFinding, ReviewReport } from "../src/review/findings";
import {
  advanceReviewRecovery,
  beginReviewRecovery,
  buildReviewFailureEnvelope,
} from "../src/review/recovery";
import {
  assembleCanonicalReviewReport,
  beginReportAssembly,
  recordRevalidationResults,
  reportAssemblyFailure,
  reviewReportDraftSchema,
  ReviewReportValidationError,
} from "../src/review/report-assembly";

const baseSha = "5d3ec5527d1b3b0b636596a3e249a68ffe38b32d";
const baselineHead = "c61ac3256822818c14ede9af6cf7f66f12d23331";
const failedHead = "709983d85e34354a4acd0938af6f67469edd612e";
const patchFingerprint =
  "01d5dcc71c9abdf11a09b546ec6a9909a55c2d8e18a1dc75cd1715119e24755d";

function finding(id: string, title: string): ReviewFinding {
  return {
    id,
    severity: "IMPROVEMENT",
    category: "DISCOVERABILITY",
    title,
    location: {
      path: "website/scripts/check-discovery-links.mjs",
      line: id === "CR-6" ? 154 : 69,
      symbol: null,
    },
    evidence: ["The exact production replay retained this finding."],
    impact: `${title} can weaken the generated discovery contract.`,
    requirementIds: [],
  introduction: "The recorded publication path can replay the same operation without reusing its identity, so a retry exposes duplicate output to readers even though the original work already finished successfully.",
  principle: "Retries must preserve the recorded publication identity.",
  risk: "A retry can duplicate output for every reader of the affected review.",
  impactSummary: "The generated discovery contract can weaken.",
    remedy: `Retain the tested correction for ${title}.`,
    status: "open",
    staticOnly: false,
    churn: null,
  };
}

function baselineReport(): ReviewReport {
  return {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-08-23T00:30:00.000Z",
    verdict: "APPROVE_WITH_IMPROVEMENTS",
    scope: {
      claim: "Review the prior delta",
      base: baseSha,
      head: baselineHead,
      dirtyState: "clean",
    },
    coverage: {
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
        "discoverability",
      ],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [
      finding("CR-4", "Keep the homepage identity source shared"),
      finding("CR-6", "Parse every llms.txt link"),
      finding("CR-7", "Parse rel values as tokens"),
    ],
    verifiedClaims: [],
    limitations: [],
  };
}

function assemblyState() {
  return beginReportAssembly({
    executionRevision: "review-report-v2",
    repositoryId: "R_pascal_mcp_sdk",
    pullRequest: 61,
    baseSha,
    headSha: failedHead,
    patchFingerprint,
    planKind: "delta",
    baselineHead,
    reviewPaths: ["website/scripts/check-discovery-links.mjs", "src/review.ts"],
    activeAxes: [
      "deduplication",
      "claim-and-specification",
      "engineering-quality",
      "discoverability",
    ],
    selectedFindingIds: ["CR-6", "CR-7"],
  });
}

function draft() {
  return {
    actionSummary: "Reviewed the affected publication paths and retained the observed evidence.", additionalConcerns: [],
    scope: {
      claim: "Review the exact 709983d delta and revalidate CR-6 and CR-7",
      dirtyState: "clean",
    },
    coverage: { staticOnly: [], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [
      {
        commandOrAction: "Replay the discovery checker fixtures",
        result: "The CR-6 and CR-7 corrections passed.",
      },
    ],
    freshFindings: [],
    verifiedClaims: ["Every active axis completed its exact evidence packet."],
    limitations: [],
  };
}

describe("application-owned review report assembly", () => {
  test("canonical coverage retains trusted specialist selection reasons and rejects contradictory decisions", () => {
    const decisions = selectReviewAxes([{ path: "bun.lock", blobSha: "a", status: "modified", patch: null }], []);
    const identity = { ...assemblyState().identity, planKind: "full" as const, baselineHead: null,
      activeAxes: decisions.filter((item) => item.selected).map((item) => item.axis), selectedFindingIds: [], axisDecisions: decisions };
    const state = beginReportAssembly(identity);
    const report = assembleCanonicalReviewReport({ state, priorReport: null, draft: draft(), generatedAt: baselineReport().generatedAt }).report;
    expect(report?.coverage.skippedAxes).toEqual(decisions.filter((item) => !item.selected).map((item) => ({ name: item.axis, reason: item.reason })));
    expect(() => beginReportAssembly({ ...identity, axisDecisions: decisions.map((item) => ({ ...item, selected: true })) })).toThrow();
  });

  test("runtime-backed findings cannot become fixed on source-only revalidation", () => {
    const prior = baselineReport();
    const state = recordRevalidationResults(assemblyState(), prior.findings.filter((item) => item.id !== "CR-4")
      .map((item) => ({ ...item, status: "fixed", staticOnly: true })));
    expect(() => assembleCanonicalReviewReport({ state, priorReport: prior, draft: draft(), generatedAt: prior.generatedAt }))
      .toThrow("requires runtime evidence matching the original finding");
    const deferred = recordRevalidationResults(assemblyState(), prior.findings.filter((item) => item.id !== "CR-4")
      .map((item) => ({ ...item, status: "deferred", staticOnly: true })));
    expect(assembleCanonicalReviewReport({ state: deferred, priorReport: prior, draft: draft(), generatedAt: prior.generatedAt }).report?.findings[1]?.status)
      .toBe("deferred");
  });

  test("pins delta assembly to its baseline while allowing the base branch to advance", () => {
    const prior = baselineReport();
    const state = recordRevalidationResults(assemblyState(), prior.findings.filter((item) => item.id !== "CR-4"));
    const advancedBase = { ...state, identity: { ...state.identity, baseSha: "9".repeat(40) } };
    expect(assembleCanonicalReviewReport({ state: advancedBase, priorReport: prior, draft: draft(), generatedAt: prior.generatedAt })
      .report?.scope.base).toBe("9".repeat(40));
    expect(() => assembleCanonicalReviewReport({
      state, priorReport: { ...prior, scope: { ...prior.scope, head: "8".repeat(40) } },
      draft: draft(), generatedAt: prior.generatedAt,
    })).toThrow(ReviewReportValidationError);
  });

  test("rejects fresh delta findings outside the dispatched file scope", () => {
    const prior = baselineReport();
    const state = recordRevalidationResults(assemblyState(), prior.findings.filter((item) => item.id !== "CR-4"));
    const { id: _id, status: _status, ...fresh } = finding("CR-8", "Out of scope");
    expect(() => assembleCanonicalReviewReport({
      state, priorReport: prior, generatedAt: prior.generatedAt,
      draft: { ...draft(), freshFindings: [{ ...fresh, location: { ...fresh.location, path: "unrelated.ts" } }] },
    })).toThrow(ReviewReportValidationError);
  });

  test("reopens a recurring fixed finding with its stable identity", () => {
    const prior = baselineReport();
    prior.findings[0]!.status = "fixed";
    const state = recordRevalidationResults(assemblyState(), prior.findings.filter((item) => item.id !== "CR-4"));
    const { id: _id, status: _status, ...fresh } = prior.findings[0]!;
    const result = assembleCanonicalReviewReport({
      state, priorReport: prior, generatedAt: prior.generatedAt,
      draft: { ...draft(), freshFindings: [fresh] },
    }).report!;
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toMatchObject({ id: "CR-4", status: "open" });
  });

  test("replays the 709983d failure from completed axes and CR-6/CR-7 outcomes", () => {
    const prior = baselineReport();
    const completed = recordRevalidationResults(
      assemblyState(),
      prior.findings
        .filter(({ id }) => id === "CR-6" || id === "CR-7")
        .map((item) => ({ ...item, status: "fixed" as const })),
    );
    const assembled = assembleCanonicalReviewReport({
      draft: draft(),
      generatedAt: "2026-08-23T01:02:00.000Z",
      priorReport: prior,
      state: completed,
    });

    expect(assembled.report).toMatchObject({
      schemaVersion: 2,
      scope: { base: baseSha, head: failedHead },
      verdict: "APPROVE_WITH_IMPROVEMENTS",
      findings: [
        { id: "CR-4", status: "open" },
        { id: "CR-6", status: "fixed" },
        { id: "CR-7", status: "fixed" },
      ],
    });
    expect(prior.scope.head).toBe(baselineHead);
  });

  test("retains only value-free schema codes and paths after invalid input", () => {
    const invalid = {
      ...draft(),
      freshFindings: [{ token: "secret-value", location: { path: "/tmp" } }],
    };
    let error: unknown;
    try {
      assembleCanonicalReviewReport({
        draft: invalid,
        generatedAt: "2026-08-23T01:02:00.000Z",
        priorReport: baselineReport(),
        state: recordRevalidationResults(
          assemblyState(),
          baselineReport().findings
            .filter(({ id }) => id === "CR-6" || id === "CR-7")
            .map((item) => ({ ...item, status: "fixed" as const })),
        ),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ReviewReportValidationError);
    const failed = reportAssemblyFailure(assemblyState(), error);
    expect(failed.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed.diagnostics)).toContain("freshFindings");
    expect(JSON.stringify(failed.diagnostics)).not.toContain("secret-value");
  });

  test("allocates fresh finding IDs in deterministic content order", () => {
    const prior = baselineReport();
    const completed = recordRevalidationResults(
      assemblyState(),
      prior.findings
        .filter(({ id }) => id === "CR-6" || id === "CR-7")
        .map((item) => ({ ...item, status: "fixed" as const })),
    );
    const { id: _firstId, status: _firstStatus, ...first } = finding(
      "CR-8",
      "Alpha correction",
    );
    const { id: _secondId, status: _secondStatus, ...second } = finding(
      "CR-9",
      "Beta correction",
    );
    const assemble = (freshFindings: readonly [typeof first, typeof second]) =>
      assembleCanonicalReviewReport({
        draft: { ...draft(), freshFindings },
        generatedAt: "2026-08-23T01:02:00.000Z",
        priorReport: prior,
        state: completed,
      }).report?.findings.slice(-2).map(({ id, title }) => ({ id, title }));

    expect(assemble([second, first])).toEqual(assemble([first, second]));
    expect(assemble([second, first])).toEqual([
      { id: "CR-8", title: "Alpha correction" },
      { id: "CR-9", title: "Beta correction" },
    ]);
  });

  test("contains every accepted category and churn draft in canonical assembly", () => {
    const categories = [
      "CLAIM",
      "QUALITY",
      "ARCHITECTURE_RISK",
      "DISCOVERABILITY",
    ] as const;
    const churn = {
      granularity: "file" as const,
      window: "90 days",
      touches: 1,
      linesAdded: 2,
      linesDeleted: 3,
      coSignals: [],
    };
    const canonicalCategories: string[] = [];

    for (const category of categories) {
      for (const candidateChurn of [null, churn] as const) {
        const candidate = {
          severity: "IMPROVEMENT" as const,
          category,
          title: `${category} candidate`,
          location: { path: "src/review.ts", line: 1, symbol: null },
          evidence: ["The exact evidence supports the candidate."],
          impact: "The report could be incomplete.",
          requirementIds: [],
  introduction: "The recorded publication path can replay the same operation without reusing its identity, so a retry exposes duplicate output to readers even though the original work already finished successfully.",
  principle: "Retries must preserve the recorded publication identity.",
  risk: "A retry can duplicate output for every reader of the affected review.",
  impactSummary: "The report could be incomplete.",
          remedy: "Keep the contract structurally aligned.",
          staticOnly: false,
          churn: candidateChurn,
        };
        const candidateDraft = {
          ...draft(),
          freshFindings: [candidate],
        };
        const parsed = reviewReportDraftSchema.safeParse(candidateDraft);
        const shouldAccept =
          category === "ARCHITECTURE_RISK"
            ? candidateChurn !== null
            : candidateChurn === null;

        expect(parsed.success).toBe(shouldAccept);
        if (!parsed.success) continue;
        const assembled = assembleCanonicalReviewReport({
          draft: parsed.data,
          generatedAt: "2026-08-23T01:02:00.000Z",
          priorReport: baselineReport(),
          state: recordRevalidationResults(
            assemblyState(),
            baselineReport().findings
              .filter(({ id }) => id === "CR-6" || id === "CR-7")
              .map((item) => ({ ...item, status: "fixed" as const })),
          ),
        });
        canonicalCategories.push(assembled.report!.findings.at(-1)!.category);
      }
    }

    expect(canonicalCategories).toEqual([
      "CLAIM",
      "QUALITY",
      "ARCHITECTURE_RISK",
      "DISCOVERABILITY",
    ]);
  });

  test("rejects unsafe paths at the model-facing boundary", () => {
    const { id: _id, status: _status, ...candidate } = finding(
      "CR-8",
      "Repository-relative location",
    );

    for (const path of ["/tmp/x", "../x", "a\\b", "a/../b"]) {
      expect(
        reviewReportDraftSchema.safeParse({
          ...draft(),
          freshFindings: [
            { ...candidate, location: { ...candidate.location, path } },
          ],
        }).success,
      ).toBeFalse();
    }
  });

  test("owns fresh status and skipped axes in application code", () => {
    const { id: _id, status: _status, ...candidate } = finding(
      "CR-8",
      "Application-owned fields",
    );
    const state = beginReportAssembly({
      executionRevision: "review-report-v2",
      repositoryId: "R_pascal_mcp_sdk",
      pullRequest: 63,
      baseSha,
      headSha: failedHead,
      patchFingerprint,
      planKind: "full",
      baselineHead: null,
      reviewPaths: [],
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
      ],
      selectedFindingIds: [],
    });
    const assembled = assembleCanonicalReviewReport({
      draft: { ...draft(), freshFindings: [candidate] },
      generatedAt: "2026-08-23T01:02:00.000Z",
      priorReport: null,
      state,
    });

    expect(assembled.report?.findings).toMatchObject([
      { id: "CR-1", status: "open" },
    ]);
    expect(assembled.report?.coverage.skippedAxes).toEqual([
      {
        name: "discoverability",
        reason: "No public web surface matched trusted review configuration.",
      },
      {
        name: "test-against-spec",
        reason: "Axis not activated by the trusted review plan.",
      },
      {
        name: "writing-quality",
        reason: "No authored prose matched the trusted review scope.",
      },
      {
        name: "test-health",
        reason: "No code, tests, or execution configuration matched the trusted review scope.",
      },
    ]);
  });

  test("coalesces duplicate fresh identities deterministically", () => {
    const { id: _id, status: _status, ...candidate } = finding(
      "CR-8",
      "Shared candidate",
    );
    const duplicate = {
      ...candidate,
      location: { ...candidate.location, line: candidate.location.line + 1 },
      evidence: ["A second axis reproduced the same defect."],
      staticOnly: true,
    };
    const prior = baselineReport();
    const completed = recordRevalidationResults(
      assemblyState(),
      prior.findings
        .filter(({ id }) => id === "CR-6" || id === "CR-7")
        .map((item) => ({ ...item, status: "fixed" as const })),
    );
    const assemble = (freshFindings: readonly [typeof candidate, typeof duplicate]) =>
      assembleCanonicalReviewReport({
        draft: { ...draft(), freshFindings },
        generatedAt: "2026-08-23T01:02:00.000Z",
        priorReport: prior,
        state: completed,
      }).report!.findings.at(-1)!;

    expect(assemble([candidate, duplicate])).toEqual(
      assemble([duplicate, candidate]),
    );
    expect(assemble([candidate, duplicate])).toMatchObject({
      id: "CR-8",
      status: "open",
      evidence: [
        "A second axis reproduced the same defect.",
        "The exact production replay retained this finding.",
      ],
      staticOnly: false,
    });
  });

  test("keeps the last known-good baseline while a validated head awaits publication", () => {
    const prior = baselineReport();
    const assembled = assembleCanonicalReviewReport({
      draft: draft(),
      generatedAt: "2026-08-23T01:02:00.000Z",
      priorReport: prior,
      state: recordRevalidationResults(
        assemblyState(),
        prior.findings
          .filter(({ id }) => id === "CR-6" || id === "CR-7")
          .map((item) => ({ ...item, status: "fixed" as const })),
      ),
    });
    const encoded = encodeReviewState({
      schemaVersion: 2,
      app: "known-good-review",
      pullRequest: 61,
      initialFullStatus: "completed",
      baseline: {
        head: baselineHead,
        patchFingerprint: "b".repeat(64),
        findingsArtifactUrl: "https://github.com/frostney/pascal-mcp-sdk/runs/1",
        files: {},
        report: prior,
      },
      pendingPublication: {
        identity: assembled.identity,
        report: assembled.report!,
        stagedAt: "2026-08-23T01:02:00.000Z",
      },
      updatedAt: "2026-08-23T01:02:00.000Z",
    });
    const decoded = decodeReviewState(encoded);

    expect(decoded?.baseline?.head).toBe(baselineHead);
    expect(decoded?.pendingPublication?.report.scope.head).toBe(failedHead);
  });

  test("selects only the staged GitHub operation for publication recovery", () => {
    const prior = baselineReport();
    const assembled = assembleCanonicalReviewReport({
      draft: draft(),
      generatedAt: "2026-08-23T01:02:00.000Z",
      priorReport: prior,
      state: recordRevalidationResults(
        assemblyState(),
        prior.findings
          .filter(({ id }) => id === "CR-6" || id === "CR-7")
          .map((item) => ({ ...item, status: "fixed" as const })),
      ),
    });
    const recovery = advanceReviewRecovery(
      advanceReviewRecovery(
        advanceReviewRecovery(
          beginReviewRecovery({
            activeAxes: assembled.identity.activeAxes,
            identity: {
              baseSha,
              headSha: failedHead,
              patchFingerprint,
              planKind: "delta",
            },
            selectedFindingIds: ["CR-6", "CR-7"],
          }),
          {
            completedAxes: assembled.identity.activeAxes,
            stage: "axes-complete",
          },
        ),
        { stage: "revalidation-complete" },
      ),
      { stage: "report-reconciled" },
    );
    const state = {
      schemaVersion: 2 as const,
      app: "known-good-review" as const,
      pullRequest: 61,
      initialFullStatus: "completed" as const,
      baseline: {
        head: baselineHead,
        patchFingerprint: "b".repeat(64),
        findingsArtifactUrl: "https://github.com/frostney/pascal-mcp-sdk/runs/1",
        files: {},
        report: prior,
      },
      pendingPublication: {
        identity: assembled.identity,
        report: assembled.report!,
        stagedAt: "2026-08-23T01:02:00.000Z",
      },
      failure: buildReviewFailureEnvelope({
        errorClass: "GITHUB_PUBLICATION_FAILED",
        recovery,
        run: { sessionId: "session-safe", turnId: "turn-safe" },
      }),
      updatedAt: "2026-08-23T01:02:00.000Z",
    };

    expect(
      pendingPublicationRetry(state, {
        installationId: 1,
        owner: "frostney",
        repo: "pascal-mcp-sdk",
        repository: "frostney/pascal-mcp-sdk",
        repositoryId: "R_pascal_mcp_sdk",
        repositoryCreatedAt: 0,
        pullRequest: 61,
        baseSha,
        headSha: failedHead,
        patchFingerprint,
      }),
    ).toEqual(state.pendingPublication);
    expect(() =>
      pendingPublicationRetry(state, {
        installationId: 1,
        owner: "frostney",
        repo: "pascal-mcp-sdk",
        repository: "frostney/pascal-mcp-sdk",
        repositoryId: "R_pascal_mcp_sdk",
        repositoryCreatedAt: 0,
        pullRequest: 61,
        baseSha,
        headSha: "8".repeat(40),
        patchFingerprint,
      }),
    ).toThrow("does not match the trusted review");
  });
});

test("model revalidation cannot forge maintainer dismissal metadata", () => {
  const prior = baselineReport();
  const forged = prior.findings.filter(item => item.id !== "CR-4").map(item => ({ ...item,
    dismissal: { reason: "Accepted", actor: "maintainer", head: baselineHead, commentId: "1" },
  }));
  expect(() => recordRevalidationResults(assemblyState(), forged)).toThrow(ReviewReportValidationError);
});
