import { z } from "zod";
import type { ReviewAxis } from "./axes";
import { reviewAxisSchema } from "./axes";
import {
  findingChurnSchema,
  reviewFindingEvidenceSchema,
  findingImpactSummarySchema,
} from "./findings";
import { isSpecialistAxis } from "./specialist-scope";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const observationSchema = z.object({
  disposition: z.enum(["candidate", "dismissed", "lead"]),
  summary: z.string().min(1).max(1_000),
  evidence: z.array(z.string().min(1).max(500)).max(12),
});

const boundedReportText = z.string().min(1).max(2_000);
const laneReportCandidateSchema = reviewFindingEvidenceSchema
  .extend({
    churn: findingChurnSchema.nullable(),
    uncertainty: z.array(boundedReportText).max(12),
  });

export const specialistCheckSchema = z.strictObject({
  entries: z.array(z.number().int().nonnegative()).min(1).max(2_000),
  requirement: boundedReportText,
  source: boundedReportText,
  expected: boundedReportText,
  environment: boundedReportText,
  action: boundedReportText,
  observed: boundedReportText,
  status: z.enum(["passed", "failed", "unverified", "out-of-scope"]),
});

export const requirementCheckSchema = z.strictObject({
  sourceId: z.string().regex(/^req-[a-f0-9]{24}$/),
  obligationId: z.string().regex(/^ob-[a-f0-9]{24}$/).nullable(),
  requirement: boundedReportText,
  establishedRequirement: boundedReportText,
  basis: z.enum(["established", "new-claim", "approved-change", "not-applicable"]),
  proposedChange: boundedReportText,
  approvalEvidence: boundedReportText.nullable(),
  expected: boundedReportText,
  observed: boundedReportText,
  action: boundedReportText,
  environment: boundedReportText,
  status: z.enum(["passed", "failed", "unverified", "out-of-scope"]),
});

export const laneCompletedReportSchema = z
  .strictObject({
    axis: reviewAxisSchema,
    scope: z
      .strictObject({
        claim: boundedReportText,
        dirtyState: boundedReportText,
        inspectedSupportingContext: z.array(boundedReportText).max(100),
      }),
    coverage: z
      .strictObject({
        staticOnly: z.array(boundedReportText).max(100),
        unreached: z.array(boundedReportText).max(100),
      }),
    churn: z
      .strictObject({
        window: boundedReportText,
        symbolCoverage: z.array(boundedReportText).max(100),
        fileFallbacks: z.array(boundedReportText).max(100),
      }),
    probes: z
      .array(
        z
          .strictObject({
            commandOrAction: boundedReportText,
            result: boundedReportText,
          }),
      )
      .max(100),
    candidates: z.array(laneReportCandidateSchema).max(100),
    verifiedClaims: z.array(boundedReportText).max(100),
    limitations: z.array(boundedReportText).max(100),
    specialistChecks: z.array(specialistCheckSchema).max(2_000).nullable().optional(),
    requirementChecks: z.array(requirementCheckSchema).max(2_000).nullable().optional(),
  })
  .refine(
    (report) =>
      Buffer.byteLength(JSON.stringify(report), "utf8") <= 24_000,
    "A completed lane report must not exceed 24,000 UTF-8 bytes",
  );

export type LaneCompletedReport = z.infer<typeof laneCompletedReportSchema>;

const laneCompletedReportDraftSchema = laneCompletedReportSchema.safeExtend({
  candidates: z.array(laneReportCandidateSchema.extend({ impactSummary: findingImpactSummarySchema })).max(100),
  specialistChecks: z.array(specialistCheckSchema).max(2_000).nullable(),
  requirementChecks: z.array(requirementCheckSchema).max(2_000).nullable(),
});

export const laneCheckpointContentSchema = z
  .strictObject({
    status: z.enum(["in-progress", "complete"]),
    reviewedEntries: z.array(z.number().int().nonnegative()).max(2_000),
    remainingEntries: z.array(z.number().int().nonnegative()).max(2_000),
    observations: z.array(observationSchema).max(40),
    nextSteps: z.array(z.string().min(1).max(500)).max(20),
    limitations: z.array(z.string().min(1).max(500)).max(20),
    completedReport: laneCompletedReportSchema.nullable(),
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.status === "complete" && !checkpoint.completedReport) {
      ctx.addIssue({
        code: "custom",
        path: ["completedReport"],
        message:
          "A complete lane checkpoint requires its terminal worker report",
      });
    }
    if (
      checkpoint.status === "complete" &&
      (checkpoint.observations.length > 0 ||
        checkpoint.nextSteps.length > 0 ||
        checkpoint.limitations.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A complete lane checkpoint stores observations, next steps, and limitations only in its terminal report",
      });
    }
    if (
      checkpoint.status === "in-progress" &&
      checkpoint.completedReport !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["completedReport"],
        message:
          "An in-progress lane checkpoint cannot contain a terminal report",
      });
    }
  });

export const laneCheckpointSchema = laneCheckpointContentSchema.extend({
  schemaVersion: z.literal(3),
  axis: reviewAxisSchema,
  baseSha: revisionSchema,
  headSha: revisionSchema,
  patchFingerprint: fingerprintSchema,
  evidenceDigest: fingerprintSchema,
  laneRegistryDigest: fingerprintSchema.optional(),
  revision: z.number().int().positive(),
});

export const laneCheckpointDraftContentSchema = laneCheckpointContentSchema.safeExtend({
  completedReport: laneCompletedReportDraftSchema.nullable(),
});

export type LaneCheckpointContent = z.infer<typeof laneCheckpointContentSchema>;
export type LaneCheckpoint = z.infer<typeof laneCheckpointSchema>;

export interface LaneCheckpointIdentity {
  readonly baseSha: string;
  readonly headSha: string;
  readonly patchFingerprint: string;
  readonly evidenceDigest: string;
  readonly laneRegistryDigest?: string | undefined;
}

export interface LaneCheckpointSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  writeTextFile(options: {
    readonly content: string;
    readonly path: string;
  }): PromiseLike<void>;
}

const maxCheckpointBytes = 65_536;
export const reviewExecutionRevision = "review-context-v3";

function validateCompletedReportAxis(
  axis: ReviewAxis,
  content: LaneCheckpointContent,
): void {
  if (
    content.completedReport !== null &&
    content.completedReport.axis !== axis
  ) {
    throw new Error("A completed lane report must match its checkpoint axis");
  }
}

export function validateLaneCheckpointCoverage(
  content: LaneCheckpointContent,
  entryCount: number,
  requirementIds: readonly string[] = [],
  obligations: readonly { id: string; sourceId: string }[] = [],
): void {
  const exactEntryCount = z.number().int().nonnegative().parse(entryCount);
  const reviewed = new Set(content.reviewedEntries);
  const remaining = new Set(content.remainingEntries);
  if (reviewed.size !== content.reviewedEntries.length) {
    throw new Error("Lane checkpoint contains duplicate reviewed entries");
  }
  if (remaining.size !== content.remainingEntries.length) {
    throw new Error("Lane checkpoint contains duplicate remaining entries");
  }
  if ([...reviewed].some((index) => remaining.has(index))) {
    throw new Error(
      "Lane checkpoint entries cannot be both reviewed and remaining",
    );
  }
  const expected = new Set(
    Array.from({ length: exactEntryCount }, (_, index) => index),
  );
  const observed = new Set([...reviewed, ...remaining]);
  if (
    expected.size !== observed.size ||
    [...expected].some((index) => !observed.has(index))
  ) {
    throw new Error(
      "Lane checkpoint coverage must match the exact review scope",
    );
  }
  if (content.status === "complete" && remaining.size > 0) {
    throw new Error("A complete lane checkpoint cannot have remaining entries");
  }
  const report = content.completedReport;
  if (report && isSpecialistAxis(report.axis)) {
    if (report.specialistChecks == null) throw new Error("A specialist report requires explicit coverage checks");
    const checked = new Set(report.specialistChecks.flatMap((check) => check.entries));
    if (checked.size !== expected.size || [...checked].some((index) => !expected.has(index))) {
      throw new Error("Specialist checks must classify every manifest entry without expanding scope");
    }
  }
  if (report) {
    if ((report.specialistChecks ?? []).some((check) => check.status === "unverified") ||
        (report.requirementChecks ?? []).some((check) => check.status === "unverified")) {
      throw new Error("Required verification remains unverified; repair and retry or keep the review incomplete");
    }
    const checks = report.requirementChecks ?? [];
    if (checks.some((check) => (check.basis === "not-applicable") !== (check.status === "out-of-scope"))) {
      throw new Error("Only an explicitly inapplicable requirement can be classified out-of-scope");
    }
    if (checks.some((check) => check.basis === "approved-change" && check.approvalEvidence === null)) {
      throw new Error("Superseding an established requirement requires explicit maintainer approval evidence");
    }
    const expectedSources = new Set(requirementIds);
    const checkedSources = new Set(checks.map((check) => check.sourceId));
    if ([...checkedSources].some((id) => !expectedSources.has(id))) {
      throw new Error("Requirement checks must cite prepared source IDs without expanding scope");
    }
    for (const check of checks) {
      if (check.obligationId !== null && !obligations.some((obligation) => obligation.id === check.obligationId && obligation.sourceId === check.sourceId)) {
        throw new Error("Requirement checks must bind each obligation to its prepared source");
      }
    }
    if ((report.axis === "claim-and-specification" || report.axis === "test-against-spec" || report.axis.startsWith("project-")) &&
        obligations.some((obligation) => !checks.some((check) => check.obligationId === obligation.id && check.sourceId === obligation.sourceId))) {
      throw new Error("Requirement checks must classify every explicit criterion; a source-level pass cannot cover omitted obligations");
    }
    if ((report.axis === "claim-and-specification" || report.axis === "test-against-spec" || report.axis.startsWith("project-")) &&
        [...expectedSources].some((id) => !checkedSources.has(id))) {
      throw new Error("Requirement checks must classify every prepared source, including unchanged obligations");
    }
  }
}

export function validateLaneCheckpointEvidenceProgress(
  content: LaneCheckpointContent,
  progress: {
    readonly completedEntries: readonly number[];
    readonly cursor: unknown | null;
  },
): void {
  if (
    JSON.stringify(content.reviewedEntries) !==
    JSON.stringify(progress.completedEntries)
  ) {
    throw new Error(
      "Lane checkpoint reviewed entries must match application-recorded evidence coverage",
    );
  }
  if (content.status === "complete" && progress.cursor !== null) {
    throw new Error(
      "A lane cannot complete before its immutable evidence packets are exhausted",
    );
  }
}

export function laneCheckpointPath(
  patchFingerprint: string,
  axis: ReviewAxis,
): string {
  const fingerprint = fingerprintSchema.parse(patchFingerprint);
  const reviewAxis = reviewAxisSchema.parse(axis);
  return `/tmp/known-good-review/checkpoints/${reviewExecutionRevision}/${fingerprint}/${reviewAxis}.json`;
}

export async function readLaneCheckpoint(
  sandbox: LaneCheckpointSandbox,
  identity: LaneCheckpointIdentity,
  axis: ReviewAxis,
): Promise<LaneCheckpoint | null> {
  const source = await sandbox.readTextFile({
    path: laneCheckpointPath(identity.patchFingerprint, axis),
  });
  if (source === null) return null;
  const checkpoint = laneCheckpointSchema.parse(JSON.parse(source));
  validateCompletedReportAxis(axis, checkpoint);
  if (
    checkpoint.axis !== axis ||
    checkpoint.baseSha !== identity.baseSha ||
    checkpoint.headSha !== identity.headSha ||
    checkpoint.patchFingerprint !== identity.patchFingerprint ||
    checkpoint.evidenceDigest !== identity.evidenceDigest ||
    checkpoint.laneRegistryDigest !== identity.laneRegistryDigest
  ) {
    throw new Error("Lane checkpoint does not match the trusted review");
  }
  return checkpoint;
}

export async function writeLaneCheckpoint(
  sandbox: LaneCheckpointSandbox,
  identity: LaneCheckpointIdentity,
  axis: ReviewAxis,
  content: LaneCheckpointContent,
  entryCount: number,
  requirementIds: readonly string[] = [],
  obligations: readonly { id: string; sourceId: string }[] = [],
): Promise<LaneCheckpoint> {
  const parsedContent = laneCheckpointContentSchema.parse(content);
  validateCompletedReportAxis(axis, parsedContent);
  validateLaneCheckpointCoverage(parsedContent, entryCount, requirementIds, obligations);
  const prior = await readLaneCheckpoint(sandbox, identity, axis);
  if (prior) validateLaneCheckpointCoverage(prior, entryCount, requirementIds, obligations);
  if (prior?.status === "complete") {
    if (
      parsedContent.status === "complete" &&
      JSON.stringify(laneCheckpointContentSchema.strip().parse(prior)) ===
        JSON.stringify(parsedContent)
    ) {
      return prior;
    }
    throw new Error("A completed review lane cannot be replaced");
  }
  const checkpoint = laneCheckpointSchema.parse({
    schemaVersion: 3,
    axis,
    ...identity,
    revision: (prior?.revision ?? 0) + 1,
    ...parsedContent,
  });
  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxCheckpointBytes) {
    throw new Error("Lane checkpoint exceeds the 64 KiB limit");
  }
  await sandbox.writeTextFile({
    path: laneCheckpointPath(identity.patchFingerprint, axis),
    content: serialized,
  });
  return checkpoint;
}
