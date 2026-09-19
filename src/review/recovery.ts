import { z } from "zod";
import { reviewAxisSchema, maxReviewLanes } from "./axes";
import {
  schemaDiagnosticSchema,
  type SchemaDiagnostic,
} from "./report-assembly";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const findingIdSchema = z.string().regex(/^CR-[1-9]\d*$/);
const safeCorrelationSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const errorClassSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, {
  error: "Review recovery error class must be a bounded symbolic identifier",
});

export const reviewRecoveryStages = [
  "started",
  "axes-complete",
  "revalidation-complete",
  "report-reconciled",
  "published",
] as const;

export const reviewRecoveryStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionRevision: z.literal("review-recovery-v1"),
    baseSha: revisionSchema,
    headSha: revisionSchema,
    patchFingerprint: fingerprintSchema,
    laneRegistryDigest: fingerprintSchema.optional(),
    planKind: z.enum(["full", "delta"]),
    activeAxes: z.array(reviewAxisSchema).min(1).max(maxReviewLanes),
    selectedFindingIds: z.array(findingIdSchema).max(100),
    stage: z.enum(reviewRecoveryStages),
    completedAxes: z.array(reviewAxisSchema).max(maxReviewLanes),
  })
  .superRefine((state, context) => {
    const active = new Set(state.activeAxes);
    if (active.size !== state.activeAxes.length) {
      context.addIssue({
        code: "custom",
        path: ["activeAxes"],
        message: "Review recovery axes must be unique",
      });
    }
    const completed = new Set(state.completedAxes);
    if (completed.size !== state.completedAxes.length) {
      context.addIssue({
        code: "custom",
        path: ["completedAxes"],
        message: "Completed review recovery axes must be unique",
      });
    }
    if ([...completed].some((axis) => !active.has(axis))) {
      context.addIssue({
        code: "custom",
        path: ["completedAxes"],
        message: "Completed axes must belong to the trusted review",
      });
    }
    if (
      new Set(state.selectedFindingIds).size !==
      state.selectedFindingIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedFindingIds"],
        message: "Review recovery finding identities must be unique",
      });
    }
    if (state.planKind === "full" && state.selectedFindingIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["selectedFindingIds"],
        message: "A full review cannot select prior findings for revalidation",
      });
    }
    if (
      state.stage === "revalidation-complete" &&
      state.selectedFindingIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Revalidation cannot complete without selected findings",
      });
    }
    if (
      state.stage !== "started" &&
      completed.size !== active.size
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAxes"],
        message: "Post-axis recovery stages require every active axis",
      });
    }
  });

export type ReviewRecoveryState = z.infer<typeof reviewRecoveryStateSchema>;

export const reviewFailureEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    executionRevision: z.literal("review-recovery-v1"),
    baseSha: revisionSchema,
    headSha: revisionSchema,
    patchFingerprint: fingerprintSchema,
    laneRegistryDigest: fingerprintSchema.optional(),
    planKind: z.enum(["full", "delta"]),
    activeAxes: z.array(reviewAxisSchema).min(1).max(maxReviewLanes),
    selectedFindingIds: z.array(findingIdSchema).max(100),
    failedStage: z.enum([
      "axes",
      "revalidation",
      "reconciliation",
      "publication",
    ]),
    completedAxes: z.array(reviewAxisSchema).max(maxReviewLanes),
    errorClass: errorClassSchema,
    diagnostics: z.array(schemaDiagnosticSchema).max(20).optional(),
    retryEligible: z.boolean(),
    run: z.object({
      sessionId: safeCorrelationSchema,
      turnId: safeCorrelationSchema,
    }),
  })
  .superRefine((failure, context) => {
    const active = new Set(failure.activeAxes);
    const completed = new Set(failure.completedAxes);
    if (active.size !== failure.activeAxes.length) {
      context.addIssue({
        code: "custom",
        path: ["activeAxes"],
        message: "Failure envelope axes must be unique",
      });
    }
    if (completed.size !== failure.completedAxes.length) {
      context.addIssue({
        code: "custom",
        path: ["completedAxes"],
        message: "Failure envelope completed axes must be unique",
      });
    }
    if ([...completed].some((axis) => !active.has(axis))) {
      context.addIssue({
        code: "custom",
        path: ["completedAxes"],
        message: "Failure envelope completed axes must be active",
      });
    }
    if (
      new Set(failure.selectedFindingIds).size !==
      failure.selectedFindingIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedFindingIds"],
        message: "Failure envelope finding identities must be unique",
      });
    }
  });

export type ReviewFailureEnvelope = z.infer<
  typeof reviewFailureEnvelopeSchema
>;

export type RecoveryWork =
  | "axes"
  | "revalidation"
  | "reconciliation"
  | "publication";

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function beginReviewRecovery(input: {
  readonly activeAxes: ReviewRecoveryState["activeAxes"];
  readonly identity: Pick<
    ReviewRecoveryState,
    "baseSha" | "headSha" | "patchFingerprint" | "planKind" | "laneRegistryDigest"
  >;
  readonly selectedFindingIds: readonly string[];
}): ReviewRecoveryState {
  return reviewRecoveryStateSchema.parse({
    schemaVersion: 1,
    executionRevision: "review-recovery-v1",
    baseSha: input.identity.baseSha,
    headSha: input.identity.headSha,
    patchFingerprint: input.identity.patchFingerprint,
    laneRegistryDigest: input.identity.laneRegistryDigest,
    planKind: input.identity.planKind,
    activeAxes: input.activeAxes,
    selectedFindingIds: input.selectedFindingIds,
    stage: "started",
    completedAxes: [],
  });
}

export function validateReviewRecoveryIdentity(
  state: ReviewRecoveryState,
  identity: Pick<
    ReviewRecoveryState,
    "baseSha" | "headSha" | "patchFingerprint" | "planKind" | "laneRegistryDigest"
  >,
): ReviewRecoveryState {
  const recovery = reviewRecoveryStateSchema.parse(state);
  if (
    recovery.baseSha !== identity.baseSha ||
    recovery.headSha !== identity.headSha ||
    recovery.patchFingerprint !== identity.patchFingerprint ||
    recovery.planKind !== identity.planKind ||
    recovery.laneRegistryDigest !== identity.laneRegistryDigest
  ) {
    throw new Error("Review recovery state does not match the trusted review");
  }
  return recovery;
}

const allowedNextStages: Readonly<
  Record<ReviewRecoveryState["stage"], readonly ReviewRecoveryState["stage"][]>
> = {
  started: ["axes-complete"],
  "axes-complete": ["revalidation-complete", "report-reconciled"],
  "revalidation-complete": ["report-reconciled"],
  "report-reconciled": ["published"],
  published: [],
};

export function advanceReviewRecovery(
  current: ReviewRecoveryState,
  input: {
    readonly completedAxes?: readonly ReviewRecoveryState["completedAxes"][number][];
    readonly stage: Exclude<ReviewRecoveryState["stage"], "started">;
  },
): ReviewRecoveryState {
  const state = reviewRecoveryStateSchema.parse(current);
  if (state.stage === input.stage) return state;
  if (!allowedNextStages[state.stage].includes(input.stage)) {
    throw new Error(
      `Review recovery cannot skip axes or advance from ${state.stage} to ${input.stage}`,
    );
  }
  if (
    input.stage === "revalidation-complete" &&
    state.selectedFindingIds.length === 0
  ) {
    throw new Error("Review recovery has no selected findings to revalidate");
  }
  if (
    input.stage === "report-reconciled" &&
    state.selectedFindingIds.length > 0 &&
    state.stage !== "revalidation-complete"
  ) {
    throw new Error("Review recovery cannot skip selected-finding revalidation");
  }
  const completedAxes = input.completedAxes ?? state.completedAxes;
  if (
    input.stage === "axes-complete" &&
    !sameValues(completedAxes, state.activeAxes)
  ) {
    throw new Error("Review recovery cannot complete before every active axis");
  }
  return reviewRecoveryStateSchema.parse({
    ...state,
    stage: input.stage,
    completedAxes,
  });
}

export function recoveryWork(state: ReviewRecoveryState): RecoveryWork[] {
  const recovery = reviewRecoveryStateSchema.parse(state);
  if (recovery.stage === "published") return [];
  if (recovery.stage === "report-reconciled") return ["publication"];
  if (recovery.stage === "revalidation-complete") {
    return ["reconciliation", "publication"];
  }
  if (recovery.stage === "axes-complete") {
    return [
      ...(recovery.selectedFindingIds.length > 0
        ? (["revalidation"] as const)
        : []),
      "reconciliation",
      "publication",
    ];
  }
  return [
    "axes",
    ...(recovery.selectedFindingIds.length > 0
      ? (["revalidation"] as const)
      : []),
    "reconciliation",
    "publication",
  ];
}

export function buildReviewFailureEnvelope(input: {
  readonly diagnostics?: readonly SchemaDiagnostic[];
  readonly errorClass: string;
  readonly recovery: ReviewRecoveryState;
  readonly retryEligible?: boolean;
  readonly run: {
    readonly sessionId: string;
    readonly turnId: string;
  };
}): ReviewFailureEnvelope {
  const recovery = reviewRecoveryStateSchema.parse(input.recovery);
  const [failedStage = "publication"] = recoveryWork(recovery);
  return reviewFailureEnvelopeSchema.parse({
    schemaVersion: 1,
    executionRevision: recovery.executionRevision,
    baseSha: recovery.baseSha,
    headSha: recovery.headSha,
    patchFingerprint: recovery.patchFingerprint,
    laneRegistryDigest: recovery.laneRegistryDigest,
    planKind: recovery.planKind,
    activeAxes: recovery.activeAxes,
    selectedFindingIds: recovery.selectedFindingIds,
    failedStage,
    completedAxes: recovery.completedAxes,
    errorClass: input.errorClass,
    ...(input.diagnostics === undefined
      ? {}
      : { diagnostics: input.diagnostics }),
    retryEligible:
      input.retryEligible ??
      (recovery.completedAxes.length > 0 || recovery.stage !== "started"),
    run: input.run,
  });
}
