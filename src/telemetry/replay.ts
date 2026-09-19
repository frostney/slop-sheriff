import { z } from "zod";
import { reviewAxisSchema } from "../review/axes";
import {
  commonWorkKinds,
  stableCommonWorkId,
} from "../review/common-work";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime();

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

const workerSchema = z.object({
  role: z.enum(["axis", "revalidation"]),
  axis: reviewAxisSchema.nullable(),
  attempt: z.number().int().nonnegative(),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
});

const findingStatusSchema = z.enum(["absent", "open", "fixed", "deferred"]);

const replayRunSchema = z.object({
  runId: z.string().min(1),
  planKind: z.enum(["full", "delta"]),
  identity: z.object({
    baseSha: revisionSchema,
    headSha: revisionSchema,
    patchFingerprint: fingerprintSchema,
  }),
  createdAt: timestampSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  preparedEvidence: z.object({
    manifestEntries: z.number().int().nonnegative(),
    commonWorkKinds: z.array(z.enum(commonWorkKinds)),
  }),
  laneCheckpoints: z.array(
    z.object({
      axis: reviewAxisSchema,
      attempt: z.number().int().nonnegative(),
      status: z.literal("complete"),
      reviewedEntries: z.array(z.number().int().nonnegative()),
      remainingEntries: z.array(z.number().int().nonnegative()).length(0),
    }),
  ).min(1),
  revalidation: z.array(
    z.object({
      findingId: z.string().regex(/^CR-[1-9]\d*$/),
      outcome: z.enum(["open", "fixed", "deferred"]),
    }),
  ),
  durableState: z.object({
    stage: z.enum(["published", "report-reconciled"]),
  }),
  publicationInput: z.object({
    selectedFindingIds: z.array(z.string().regex(/^CR-[1-9]\d*$/)),
    canonicalFindingIds: z.array(z.string().regex(/^CR-[1-9]\d*$/)),
    verdict: z.enum(["APPROVE", "APPROVE_WITH_IMPROVEMENTS", "REQUEST_CHANGES"]).nullable(),
  }),
  workers: z.array(workerSchema).min(1),
  usage: usageSchema,
  subagentRuns: z.number().int().nonnegative(),
  telemetry: z.object({
    modelGenerations: z.number().int().nonnegative().nullable(),
    retries: z.number().int().nonnegative().nullable(),
  }),
  findingTransitions: z.array(
    z.object({
      findingId: z.string().regex(/^CR-[1-9]\d*$/),
      before: findingStatusSchema,
      after: findingStatusSchema,
    }),
  ),
  publication: z.object({
    attempts: z.number().int().nonnegative(),
    published: z.boolean(),
    recoveryWork: z.array(z.string().min(1)),
  }),
}).superRefine((run, context) => {
  const axes = run.laneCheckpoints.map((checkpoint) => checkpoint.axis);
  if (new Set(axes).size !== axes.length) {
    context.addIssue({
      code: "custom",
      path: ["laneCheckpoints"],
      message: "Replay lane checkpoint axes must be unique",
    });
  }
  const expectedEntries = Array.from(
    { length: run.preparedEvidence.manifestEntries },
    (_, index) => index,
  );
  if (
    run.laneCheckpoints.some(
      (checkpoint) =>
        JSON.stringify(checkpoint.reviewedEntries) !==
        JSON.stringify(expectedEntries),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["laneCheckpoints"],
      message: "Replay checkpoints must cover the complete prepared manifest",
    });
  }
  if (
    new Set(run.preparedEvidence.commonWorkKinds).size !==
      commonWorkKinds.length ||
    commonWorkKinds.some(
      (kind) => !run.preparedEvidence.commonWorkKinds.includes(kind),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["preparedEvidence", "commonWorkKinds"],
      message: "Replay must retain every common work category exactly once",
    });
  }
  const selected = [...run.publicationInput.selectedFindingIds].sort();
  const revalidated = run.revalidation
    .map((finding) => finding.findingId)
    .sort();
  if (JSON.stringify(selected) !== JSON.stringify(revalidated)) {
    context.addIssue({
      code: "custom",
      path: ["revalidation"],
      message: "Replay revalidation must match the selected finding identities",
    });
  }
  if (
    run.publication.published !== (run.durableState.stage === "published") ||
    run.publication.published !== (run.publicationInput.verdict !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["publication"],
      message: "Replay publication must match its durable state and canonical input",
    });
  }
});

export const reviewReplayFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  fixture: z.literal("pascal-mcp-sdk-pr-61-review-lifecycle"),
  repository: z.literal("frostney/pascal-mcp-sdk"),
  pullRequest: z.literal(61),
  capturedAt: timestampSchema,
  runs: z.array(replayRunSchema).length(4),
});

export type ReviewReplayFixture = z.infer<typeof reviewReplayFixtureSchema>;
export type ReviewReplayRun = z.infer<typeof replayRunSchema>;

const productionTelemetrySchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  generationId: z.string().min(1),
  phase: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  usage: usageSchema,
});

export type ProductionTelemetry = z.infer<typeof productionTelemetrySchema>;

function milliseconds(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start);
  if (value < 0) throw new Error("Replay timing is not monotonic");
  return value;
}

export function deduplicateProductionTelemetry(
  input: readonly ProductionTelemetry[],
): ProductionTelemetry[] {
  const entries = input.map((entry) => productionTelemetrySchema.parse(entry));
  const unique = new Map<string, ProductionTelemetry>();
  for (const entry of entries) {
    const key = `${entry.runId}\0${entry.sessionId}\0${entry.generationId}`;
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error("Conflicting production telemetry shares one stable identity");
    }
    unique.set(key, entry);
  }
  return [...unique.values()];
}

function latest(workers: readonly z.infer<typeof workerSchema>[]): string {
  return workers.reduce(
    (observed, worker) =>
      Date.parse(worker.completedAt) > Date.parse(observed)
        ? worker.completedAt
        : observed,
    workers[0]?.completedAt ?? "",
  );
}

function earliest(workers: readonly z.infer<typeof workerSchema>[]): string {
  return workers.reduce(
    (observed, worker) =>
      Date.parse(worker.startedAt) < Date.parse(observed)
        ? worker.startedAt
        : observed,
    workers[0]?.startedAt ?? "",
  );
}

export function replayRecordedReview(input: ReviewReplayRun) {
  const run = replayRunSchema.parse(input);
  const axes = run.workers.filter((worker) => worker.role === "axis");
  const revalidation = run.workers.filter(
    (worker) => worker.role === "revalidation",
  );
  if (axes.length === 0) throw new Error("Replay run has no review axes");

  const firstAxisStarted = earliest(axes);
  const lastAxisCompleted = latest(axes);
  const lastWorkerCompleted = latest(run.workers);
  const axisDurations = axes.map((worker) =>
    milliseconds(worker.startedAt, worker.completedAt),
  );
  const productionAxesMs = milliseconds(
    firstAxisStarted,
    lastAxisCompleted,
  );
  const concurrentAxesMs = Math.max(...axisDurations);
  const productionRevalidationMs = revalidation.length === 0
    ? 0
    : milliseconds(lastAxisCompleted, latest(revalidation));
  const phases = [
    {
      phase: "queue",
      recordedMs: milliseconds(run.createdAt, run.startedAt),
      candidateMs: milliseconds(run.createdAt, run.startedAt),
    },
    {
      phase: "common-preparation",
      recordedMs: milliseconds(run.startedAt, firstAxisStarted),
      candidateMs: milliseconds(run.startedAt, firstAxisStarted),
    },
    {
      phase: "fresh-axes",
      recordedMs: productionAxesMs,
      candidateMs: concurrentAxesMs,
    },
    {
      phase: "revalidation",
      recordedMs: productionRevalidationMs,
      candidateMs: productionRevalidationMs,
    },
    {
      phase: "reconciliation-publication",
      recordedMs: milliseconds(lastWorkerCompleted, run.completedAt),
      candidateMs: milliseconds(lastWorkerCompleted, run.completedAt),
    },
  ].map((phase) => ({
    ...phase,
    deltaMs: phase.candidateMs - phase.recordedMs,
  }));

  const commonWork = commonWorkKinds.map((kind) => ({
    kind,
    stableId: stableCommonWorkId(kind, {
      executionRevision: "review-common-work-v1",
      ...run.identity,
    }),
    recordedOccurrencesLowerBound: axes.length,
    candidateOccurrences: 1,
  }));
  const recordedCriticalPathMs = phases.reduce(
    (total, phase) => total + phase.recordedMs,
    0,
  );
  const candidateCriticalPathMs = phases.reduce(
    (total, phase) => total + phase.candidateMs,
    0,
  );
  return {
    runId: run.runId,
    planKind: run.planKind,
    identity: run.identity,
    phases,
    criticalPath: {
      recordedMs: recordedCriticalPathMs,
      candidateMs: candidateCriticalPathMs,
      deltaMs: candidateCriticalPathMs - recordedCriticalPathMs,
    },
    parallelWorkerConsumptionMs: run.workers.reduce(
      (total, worker) =>
        total + milliseconds(worker.startedAt, worker.completedAt),
      0,
    ),
    commonWork,
    preparedEvidence: run.preparedEvidence,
    laneCheckpoints: run.laneCheckpoints,
    revalidation: run.revalidation,
    durableState: run.durableState,
    publicationInput: run.publicationInput,
    telemetry: run.telemetry,
    usage: run.usage,
    publication: run.publication,
    findingTransitions: run.findingTransitions,
    measurementPolicy: "non-gating" as const,
    candidateMeasurementKind: "offline-projection" as const,
  };
}

export function replayLifecycle(input: unknown) {
  const fixture = reviewReplayFixtureSchema.parse(input);
  const runs = fixture.runs.map(replayRecordedReview);
  return {
    fixture: fixture.fixture,
    repository: fixture.repository,
    pullRequest: fixture.pullRequest,
    runs,
    cumulative: {
      inputTokens: runs.reduce((total, run) => total + run.usage.inputTokens, 0),
      cachedInputTokens: runs.reduce(
        (total, run) => total + run.usage.cachedInputTokens,
        0,
      ),
      cacheCreationInputTokens: runs.reduce(
        (total, run) => total + run.usage.cacheCreationInputTokens,
        0,
      ),
      outputTokens: runs.reduce(
        (total, run) => total + run.usage.outputTokens,
        0,
      ),
      costUsd: runs.reduce((total, run) => total + run.usage.costUsd, 0),
      recordedCriticalPathMs: runs.reduce(
        (total, run) => total + run.criticalPath.recordedMs,
        0,
      ),
      candidateCriticalPathMs: runs.reduce(
        (total, run) => total + run.criticalPath.candidateMs,
        0,
      ),
      publicationAttempts: runs.reduce(
        (total, run) => total + run.publication.attempts,
        0,
      ),
    },
    measurementPolicy: "non-gating" as const,
  };
}
