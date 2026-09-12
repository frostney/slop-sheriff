import { z } from "zod";
import { reviewAxes, reviewAxisSchema, maxReviewLanes } from "./axes";
import { findingIdentity, preserveFindingDismissals } from "./finding-identity";
import { repositoryPathSchema } from "./evidence-bundle";
import {
  additionalConcernSchema,
  findingIsOutstanding,
  reviewFindingDraftSchema,
  reviewFindingSchema,
  reviewFindingRevalidationSchema,
  reviewReportSchema,
  type ReviewFindingDraft,
  type ReviewFinding,
  type ReviewReport,
} from "./findings";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const schemaDiagnosticSchema = z.object({
  code: z.string().min(1).max(64),
  path: z.array(z.union([z.string().max(128), z.number().int().nonnegative()])).max(12),
});

export type SchemaDiagnostic = z.infer<typeof schemaDiagnosticSchema>;

export const reviewAxisDecisionsSchema = z.array(z.object({
  axis: reviewAxisSchema, selected: z.boolean(), reason: z.string().min(1),
  paths: z.array(repositoryPathSchema).max(2_000),
})).min(reviewAxes.length).max(maxReviewLanes);

export const reportAssemblyIdentitySchema = z.object({
  executionRevision: z.literal("review-report-v2"),
  repositoryId: z.string().min(1),
  pullRequest: z.number().int().positive(),
  baseSha: revisionSchema,
  headSha: revisionSchema,
  patchFingerprint: fingerprintSchema,
  laneRegistryDigest: fingerprintSchema.optional(),
  reviewPolicyDigest: fingerprintSchema.optional(),
  planKind: z.enum(["full", "delta"]),
  baselineHead: revisionSchema.nullable(),
  reviewPaths: z.array(repositoryPathSchema).max(2_000),
  activeAxes: z.array(reviewAxisSchema).min(1).max(maxReviewLanes),
  axisDecisions: reviewAxisDecisionsSchema.optional(),
  selectedFindingIds: z
    .array(z.string().regex(/^CR-[1-9]\d*$/))
    .max(100),
}).superRefine((identity, context) => {
  if (identity.axisDecisions && (new Set(identity.axisDecisions.map((item) => item.axis)).size !== identity.axisDecisions.length ||
    reviewAxes.some((axis) => !identity.axisDecisions?.some((item) => item.axis === axis)) ||
    identity.axisDecisions.some((item) => item.selected !== identity.activeAxes.includes(item.axis)) ||
    identity.activeAxes.some((axis) => !identity.axisDecisions?.some((item) => item.axis === axis)))) {
    context.addIssue({ code: "custom", path: ["axisDecisions"], message: "Triage decisions must cover each axis and agree with dispatch" });
  }
  if (identity.activeAxes.some((axis) => axis.startsWith("project-")) && !identity.laneRegistryDigest) context.addIssue({ code: "custom", path: ["laneRegistryDigest"], message: "Project lanes require their trusted registry identity" });
  if ((identity.planKind === "delta") !== (identity.baselineHead !== null)) {
    context.addIssue({ code: "custom", path: ["baselineHead"], message: "Only delta reviews require an exact baseline head" });
  }
  if (new Set(identity.activeAxes).size !== identity.activeAxes.length) {
    context.addIssue({
      code: "custom",
      path: ["activeAxes"],
      message: "Review report axes must be unique",
    });
  }
  if (
    new Set(identity.selectedFindingIds).size !==
    identity.selectedFindingIds.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectedFindingIds"],
      message: "Review report finding identities must be unique",
    });
  }
  if (identity.planKind === "full" && identity.selectedFindingIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["selectedFindingIds"],
      message: "A full review cannot select prior findings",
    });
  }
});

export type ReportAssemblyIdentity = z.infer<
  typeof reportAssemblyIdentitySchema
>;

export const reviewReportDraftSchema = z
  .strictObject({
    actionSummary: z.string().min(1).max(800),
    additionalConcerns: z.array(additionalConcernSchema).max(20),
    scope: z.object({
      claim: z.string(),
      dirtyState: z.string(),
    }),
    coverage: z.object({
      staticOnly: z.array(z.string()),
      unreached: z.array(z.string()),
    }),
    churn: z.object({
      window: z.string(),
      symbolCoverage: z.array(z.string()),
      fileFallbacks: z.array(z.string()),
    }),
    probes: z.array(
      z.object({ commandOrAction: z.string(), result: z.string() }),
    ),
    freshFindings: z.array(reviewFindingDraftSchema),
    verifiedClaims: z.array(z.string()),
    limitations: z.array(z.string()),
  });

export type ReviewReportDraft = z.infer<typeof reviewReportDraftSchema>;

export const reportAssemblyStateSchema = z.object({
  schemaVersion: z.literal(1),
  identity: reportAssemblyIdentitySchema,
  revalidatedFindings: z.array(reviewFindingSchema).max(100),
  report: reviewReportSchema.nullable(),
  diagnostics: z.array(schemaDiagnosticSchema).max(20),
});

export type ReportAssemblyState = z.infer<typeof reportAssemblyStateSchema>;

function diagnosticsFrom(error: z.ZodError): SchemaDiagnostic[] {
  return error.issues.slice(0, 20).map((issue) =>
    schemaDiagnosticSchema.parse({
      code: issue.code,
      path: issue.path.slice(0, 12).map((part) =>
        typeof part === "number" ? part : String(part).slice(0, 128),
      ),
    }),
  );
}

export class ReviewReportValidationError extends Error {
  readonly diagnostics: readonly SchemaDiagnostic[];

  constructor(diagnostics: readonly SchemaDiagnostic[], message = "Canonical review report input is invalid") {
    super(message);
    this.name = "ReviewReportValidationError";
    this.diagnostics = diagnostics;
  }
}

export function beginReportAssembly(
  identity: ReportAssemblyIdentity,
): ReportAssemblyState {
  return reportAssemblyStateSchema.parse({
    schemaVersion: 1,
    identity,
    revalidatedFindings: [],
    report: null,
    diagnostics: [],
  });
}

function sameIdentity(
  left: ReportAssemblyIdentity,
  right: ReportAssemblyIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateReportAssemblyIdentity(
  state: ReportAssemblyState,
  identity: ReportAssemblyIdentity,
): ReportAssemblyState {
  const parsed = reportAssemblyStateSchema.parse(state);
  const expected = reportAssemblyIdentitySchema.parse(identity);
  if (!sameIdentity(parsed.identity, expected)) {
    throw new Error("Review report state does not match the trusted review");
  }
  return parsed;
}

export function validateRevalidationEvidence(
  findings: readonly ReviewFinding[], priorReport: ReviewReport | null, priorRuntimeFindingIds: readonly string[] = [],
): void {
  const required = new Set([...priorRuntimeFindingIds, ...(priorReport?.findings.filter((finding) => !finding.staticOnly).map((finding) => finding.id) ?? [])]);
  for (const finding of findings) {
    if (required.has(finding.id) && finding.status === "fixed" && finding.staticOnly) {
      throw new ReviewReportValidationError([{ code: "custom", path: ["revalidatedFindings", finding.id] }],
        `Finding ${finding.id} requires runtime evidence matching the original finding. Rerun its real-interface probe or record deferred with what remains unverified.`);
    }
  }
}

export function recordRevalidationResults(
  state: ReportAssemblyState,
  value: unknown,
): ReportAssemblyState {
  const current = reportAssemblyStateSchema.parse(state);
  const parsed = z.array(reviewFindingRevalidationSchema).max(100).safeParse(value);
  if (!parsed.success) {
    const diagnostics = diagnosticsFrom(parsed.error);
    throw new ReviewReportValidationError(diagnostics);
  }
  if (current.revalidatedFindings.length > 0) {
    if (
      JSON.stringify(current.revalidatedFindings) === JSON.stringify(parsed.data)
    ) {
      return current;
    }
    throw new Error("Completed finding revalidation cannot be replaced");
  }
  const expected = [...current.identity.selectedFindingIds].sort();
  const observed = parsed.data.map((finding) => finding.id).sort();
  if (
    expected.length !== observed.length ||
    expected.some((id, index) => id !== observed[index])
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["revalidatedFindings"] },
    ]);
  }
  return reportAssemblyStateSchema.parse({
    ...current,
    revalidatedFindings: parsed.data,
    report: null,
    diagnostics: [],
  });
}

export function reportAssemblyFailure(
  state: ReportAssemblyState,
  error: unknown,
): ReportAssemblyState {
  const current = reportAssemblyStateSchema.parse(state);
  const diagnostics =
    error instanceof ReviewReportValidationError
      ? error.diagnostics
      : error instanceof z.ZodError
        ? diagnosticsFrom(error)
        : [{ code: "custom", path: [] }];
  const invalidReport =
    error instanceof ReviewReportValidationError || error instanceof z.ZodError;
  return reportAssemblyStateSchema.parse({
    ...current,
    report: invalidReport ? null : current.report,
    diagnostics,
  });
}

const severityOrder: Readonly<Record<ReviewFinding["severity"], number>> = {
  BLOCKING: 0,
  IMPORTANT: 1,
  IMPROVEMENT: 2,
  NITPICK: 3,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findingDraftIdentity(
  finding: ReviewFindingDraft,
): string {
  return findingIdentity(finding);
}

function compareFreshFindings(
  left: ReviewFindingDraft,
  right: ReviewFindingDraft,
): number {
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    compareText(left.category, right.category) ||
    compareText(left.location.path, right.location.path) ||
    left.location.line - right.location.line ||
    compareText(left.title, right.title) ||
    compareText(JSON.stringify(left), JSON.stringify(right))
  );
}

function sortedFreshFindings(
  findings: readonly ReviewFindingDraft[],
): readonly ReviewFindingDraft[] {
  return [...findings].sort(compareFreshFindings);
}

function coalesceFreshFindings(
  findings: readonly ReviewFindingDraft[],
  knownIdentities: ReadonlySet<string>,
): readonly ReviewFindingDraft[] {
  const coalesced = new Map<string, ReviewFindingDraft>();
  for (const finding of sortedFreshFindings(findings)) {
    const identity = findingDraftIdentity(finding);
    if (knownIdentities.has(identity)) continue;
    const existing = coalesced.get(identity);
    if (!existing) {
      coalesced.set(identity, finding);
      continue;
    }
    coalesced.set(identity, {
      ...existing,
      evidence: [...new Set([...existing.evidence, ...finding.evidence])].sort(
        compareText,
      ),
      staticOnly: existing.staticOnly && finding.staticOnly,
    });
  }
  return [...coalesced.values()];
}

const skippedAxisReasons = {
  deduplication: "Axis not activated by the trusted review plan.",
  "claim-and-specification": "Axis not activated by the trusted review plan.",
  "engineering-quality": "Axis not activated by the trusted review plan.",
  "test-against-spec": "Axis not activated by the trusted review plan.",
  "test-health": "No code, tests, or execution configuration matched the trusted review scope.",
  "writing-quality": "No authored prose matched the trusted review scope.",
  discoverability:
    "No public web surface matched trusted review configuration.",
} satisfies Readonly<Record<(typeof reviewAxes)[number], string>>;

function skippedReviewAxes(
  activeAxes: readonly import("./axes").ReviewAxis[],
  decisions: ReportAssemblyIdentity["axisDecisions"],
): readonly { readonly name: string; readonly reason: string }[] {
  const active = new Set(activeAxes);
  return (decisions?.map((decision) => decision.axis) ?? reviewAxes)
    .filter((axis) => !active.has(axis))
    .map((name) => ({ name, reason: decisions?.find((decision) => decision.axis === name)?.reason ?? (name in skippedAxisReasons ? skippedAxisReasons[name as keyof typeof skippedAxisReasons] : "Project criteria did not apply to this change.") }));
}

function reportVerdict(
  findings: readonly ReviewFinding[],
): ReviewReport["verdict"] {
  const active = findings.filter(findingIsOutstanding);
  if (
    active.some(
      (finding) =>
        finding.severity === "BLOCKING" || finding.severity === "IMPORTANT",
    )
  ) {
    return "REQUEST_CHANGES";
  }
  return active.length > 0 ? "APPROVE_WITH_IMPROVEMENTS" : "APPROVE";
}

function priorFindings(
  state: ReportAssemblyState,
  priorReport: ReviewReport | null,
  priorRuntimeFindingIds: readonly string[],
): ReviewFinding[] {
  if (state.identity.planKind === "full") return [];
  if (!priorReport) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["priorReport"] },
    ]);
  }
  if (
    priorReport.scope.head !== state.identity.baselineHead
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["priorReport", "scope"] },
    ]);
  }
  const priorById = new Map(
    priorReport.findings.map((finding) => [finding.id, finding] as const),
  );
  for (const id of state.identity.selectedFindingIds) {
    if (!priorById.has(id)) {
      throw new ReviewReportValidationError([
        { code: "custom", path: ["priorReport", "findings"] },
      ]);
    }
  }
  if (
    state.revalidatedFindings.length !==
    state.identity.selectedFindingIds.length
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["revalidatedFindings"] },
    ]);
  }
  const revalidated = new Map(
    state.revalidatedFindings.map((finding) => [finding.id, finding] as const),
  );
  validateRevalidationEvidence(state.revalidatedFindings, priorReport, priorRuntimeFindingIds);
  return priorReport.findings.map(
    (finding) => finding.dismissal ? finding : revalidated.get(finding.id) ?? finding,
  );
}

export function assembleCanonicalReviewReport(input: {
  readonly draft: unknown;
  readonly generatedAt: string;
  readonly priorReport: ReviewReport | null;
  readonly priorRuntimeFindingIds?: readonly string[];
  readonly state: ReportAssemblyState;
}): ReportAssemblyState {
  const state = reportAssemblyStateSchema.parse(input.state);
  if (state.report) return state;
  const draft = reviewReportDraftSchema.safeParse(input.draft);
  if (!draft.success) {
    throw new ReviewReportValidationError(diagnosticsFrom(draft.error));
  }
  if (draft.data.coverage.unreached.length > 0) {
    throw new ReviewReportValidationError([{ code: "custom", path: ["coverage", "unreached"] }], "Required verification must complete before report assembly");
  }
  if (state.identity.planKind === "delta") {
    const paths = new Set(state.identity.reviewPaths);
    if (draft.data.freshFindings.some((finding) => !paths.has(finding.location.path))) {
      throw new ReviewReportValidationError([{ code: "custom", path: ["freshFindings", "location", "path"] }]);
    }
  }

  const prior = priorFindings(state, input.priorReport, input.priorRuntimeFindingIds ?? []);
  const knownIdentities = new Set(prior.filter((finding) => finding.status !== "fixed").map(findingIdentity));
  const fresh = coalesceFreshFindings(
    draft.data.freshFindings,
    knownIdentities,
  );
  const revived = new Map(fresh.map((finding) => [findingIdentity(finding), finding]));
  const preserved = prior.map((finding) => {
    const identity = findingIdentity(finding);
    const recurrence = finding.status === "fixed" ? revived.get(identity) : undefined;
    if (!recurrence) return finding;
    revived.delete(identity);
    return { ...recurrence, id: finding.id, status: "open" as const };
  });
  const highestPriorId = preserved.reduce((highest, finding) => {
    return Math.max(highest, Number(finding.id.slice(3)));
  }, 0);
  const findings = [
    ...preserved,
    ...[...revived.values()].map((finding, index) => ({
      ...finding,
      id: `CR-${highestPriorId + index + 1}`,
      status: "open" as const,
    })),
  ].sort((left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3)));

  const report = reviewReportSchema.safeParse({
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: input.generatedAt,
    verdict: reportVerdict(findings),
    actionSummary: draft.data.actionSummary,
    additionalConcerns: draft.data.additionalConcerns,
    scope: {
      claim: draft.data.scope.claim,
      base: state.identity.baseSha,
      head: state.identity.headSha,
      dirtyState: draft.data.scope.dirtyState,
    },
    coverage: {
      activeAxes: state.identity.activeAxes,
      skippedAxes: skippedReviewAxes(state.identity.activeAxes, state.identity.axisDecisions),
      ...draft.data.coverage,
    },
    churn: draft.data.churn,
    probes: draft.data.probes,
    findings,
    verifiedClaims: draft.data.verifiedClaims,
    limitations: draft.data.limitations,
  });
  if (!report.success) {
    throw new ReviewReportValidationError(diagnosticsFrom(report.error));
  }
  return reportAssemblyStateSchema.parse({
    ...state,
    report: preserveFindingDismissals(report.data, input.priorReport),
    diagnostics: [],
  });
}
