import { createHash } from "node:crypto";
import { z } from "zod";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const artifactDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const checkRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  head_sha: revisionSchema,
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: z.string().min(1).nullable(),
  details_url: z.url().nullable(),
  external_id: z.string().nullable(),
  app: z.object({ slug: z.string().min(1).nullable() }).nullable(),
});

const workflowRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).nullable(),
  head_sha: revisionSchema,
  status: z.string().min(1).nullable(),
  conclusion: z.string().min(1).nullable(),
  event: z.string().min(1),
  run_attempt: z.number().int().positive(),
  repository: z.object({ id: z.number().int().positive() }),
  head_repository: z.object({ id: z.number().int().positive() }).nullable(),
});

const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  size_in_bytes: z.number().int().nonnegative(),
  expired: z.boolean(),
  digest: artifactDigestSchema.nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  workflow_run: z
    .object({
      id: z.number().int().positive(),
      repository_id: z.number().int().positive(),
      head_repository_id: z.number().int().positive(),
      head_sha: revisionSchema,
    })
    .nullable(),
});

export const preparedCheckRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  appSlug: z.string().min(1).nullable(),
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: z.string().min(1).nullable(),
  detailsUrl: z.url().nullable(),
  externalId: z.string().nullable(),
});

export const preparedArtifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  sizeInBytes: z.number().int().nonnegative(),
  digest: artifactDigestSchema,
  archiveFile: z.string().regex(/^artifact-[1-9]\d*\.zip$/),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  workflowRun: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).nullable(),
    event: z.string().min(1),
    attempt: z.number().int().positive(),
    conclusion: z.string().min(1).nullable(),
    repositoryDatabaseId: z.number().int().positive(),
    headRepositoryDatabaseId: z.number().int().positive().nullable(),
    headSha: revisionSchema,
  }),
});

export const evidenceGapSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.enum(["checks", "artifacts", "probe"]),
  owner: z.enum(["application", "repository", "inherent"]),
  disposition: z.enum([
    "operational-failure",
    "check-remedy",
    "review-summary",
  ]),
  summary: z.string().min(1).max(500),
  remedy: z.string().min(1).max(500).nullable(),
});

const artifactAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    entries: z.array(preparedArtifactSchema).min(1),
  }),
  z.object({
    status: z.literal("missing"),
    entries: z.tuple([]),
    disposition: evidenceGapSchema,
  }),
]);

const exactHeadGitHubEvidencePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryDatabaseId: z.number().int().positive(),
  headSha: revisionSchema,
  observedAt: z.iso.datetime(),
  checks: z.array(preparedCheckRunSchema),
  artifacts: artifactAvailabilitySchema,
  gaps: z.array(evidenceGapSchema),
});

export const exactHeadGitHubEvidenceSchema =
  exactHeadGitHubEvidencePayloadSchema.extend({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  });

export type ExactHeadGitHubEvidence = z.infer<
  typeof exactHeadGitHubEvidenceSchema
>;
export type PreparedArtifact = z.infer<typeof preparedArtifactSchema>;

export interface GitHubEvidenceInput {
  readonly artifactsByRun: ReadonlyMap<
    number,
    readonly { readonly archive: Uint8Array; readonly metadata: unknown }[]
  >;
  readonly checkRuns: readonly unknown[];
  readonly headSha: string;
  readonly observedAt: string;
  readonly repositoryDatabaseId: number;
  readonly workflowRuns: readonly unknown[];
}

export interface PreparedGitHubEvidence {
  readonly archives: ReadonlyMap<number, Uint8Array>;
  readonly evidence: ExactHeadGitHubEvidence;
}

export class GitHubEvidenceError extends Error {
  constructor(readonly code: string) {
    super(`Exact-head GitHub evidence failed validation: ${code}`);
    this.name = "GitHubEvidenceError";
  }
}

function digestPayload(
  payload: z.infer<typeof exactHeadGitHubEvidencePayloadSchema>,
): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function artifactArchiveDigest(archive: Uint8Array): string {
  return `sha256:${createHash("sha256").update(archive).digest("hex")}`;
}

function stableChecks(checkRuns: readonly unknown[], headSha: string) {
  const checks = checkRuns
    .map((input) => checkRunSchema.parse(input))
    .map((check) => {
      if (check.head_sha !== headSha) {
        throw new GitHubEvidenceError("stale-check-head");
      }
      return preparedCheckRunSchema.parse({
        id: check.id,
        name: check.name,
        appSlug: check.app?.slug ?? null,
        status: check.status,
        conclusion: check.conclusion,
        detailsUrl: check.details_url,
        externalId: check.external_id,
      });
    })
    .sort((left, right) => left.id - right.id);
  const ids = checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length) {
    throw new GitHubEvidenceError("duplicate-check-run");
  }
  return checks;
}

function preparedArtifacts(input: GitHubEvidenceInput): {
  readonly archives: Map<number, Uint8Array>;
  readonly entries: PreparedArtifact[];
} {
  const archives = new Map<number, Uint8Array>();
  const entries: PreparedArtifact[] = [];
  const seenRuns = new Set<number>();
  for (const rawRun of input.workflowRuns) {
    const run = workflowRunSchema.parse(rawRun);
    if (run.head_sha !== input.headSha) {
      throw new GitHubEvidenceError("stale-workflow-head");
    }
    if (run.repository.id !== input.repositoryDatabaseId) {
      throw new GitHubEvidenceError("mismatched-workflow-repository");
    }
    if (seenRuns.has(run.id)) {
      throw new GitHubEvidenceError("duplicate-workflow-run");
    }
    seenRuns.add(run.id);
    if (run.status !== "completed" || run.conclusion !== "success") continue;
    for (const candidate of input.artifactsByRun.get(run.id) ?? []) {
      const artifact = artifactSchema.parse(candidate.metadata);
      if (artifact.expired) continue;
      if (!artifact.workflow_run || artifact.workflow_run.id !== run.id) {
        throw new GitHubEvidenceError("mismatched-artifact-workflow");
      }
      if (
        artifact.workflow_run.repository_id !== input.repositoryDatabaseId ||
        artifact.workflow_run.head_sha !== input.headSha
      ) {
        throw new GitHubEvidenceError("mismatched-artifact-identity");
      }
      if (
        run.head_repository &&
        artifact.workflow_run.head_repository_id !== run.head_repository.id
      ) {
        throw new GitHubEvidenceError("mismatched-artifact-head-repository");
      }
      if (!artifact.digest) {
        throw new GitHubEvidenceError("artifact-digest-missing");
      }
      if (artifactArchiveDigest(candidate.archive) !== artifact.digest) {
        throw new GitHubEvidenceError("artifact-digest-mismatch");
      }
      if (archives.has(artifact.id)) {
        throw new GitHubEvidenceError("duplicate-artifact");
      }
      archives.set(artifact.id, candidate.archive);
      entries.push(
        preparedArtifactSchema.parse({
          id: artifact.id,
          name: artifact.name,
          sizeInBytes: artifact.size_in_bytes,
          digest: artifact.digest,
          archiveFile: `artifact-${artifact.id}.zip`,
          createdAt: artifact.created_at,
          expiresAt: artifact.expires_at,
          workflowRun: {
            id: run.id,
            name: run.name,
            event: run.event,
            attempt: run.run_attempt,
            conclusion: run.conclusion,
            repositoryDatabaseId: run.repository.id,
            headRepositoryDatabaseId: run.head_repository?.id ?? null,
            headSha: run.head_sha,
          },
        }),
      );
    }
  }
  entries.sort((left, right) => left.id - right.id);
  return { archives, entries };
}

export function prepareExactHeadGitHubEvidence(
  input: GitHubEvidenceInput,
): PreparedGitHubEvidence {
  const headSha = revisionSchema.parse(input.headSha);
  const repositoryDatabaseId = z
    .number()
    .int()
    .positive()
    .parse(input.repositoryDatabaseId);
  const checks = stableChecks(input.checkRuns, headSha);
  const artifacts = preparedArtifacts({
    ...input,
    headSha,
    repositoryDatabaseId,
  });
  const missingArtifactGap = evidenceGapSchema.parse({
    id: "exact-head-artifacts-missing",
    source: "artifacts",
    owner: "repository",
    disposition: "check-remedy",
    summary:
      "No reusable generated-output artifact is available for this exact head.",
    remedy:
      "Generate equivalent output in the prepared local environment when needed; use an exact-head workflow artifact when it requires CI-only infrastructure.",
  });
  const missingCheckGap = evidenceGapSchema.parse({
    id: "exact-head-checks-missing",
    source: "checks",
    owner: "repository",
    disposition: "check-remedy",
    summary: "No GitHub Check result is available for this exact head.",
    remedy:
      "Run the repository's required exact-head Checks before relying on CI evidence.",
  });
  const gaps = [
    ...(checks.length > 0 ? [] : [missingCheckGap]),
  ];
  const payload = exactHeadGitHubEvidencePayloadSchema.parse({
    schemaVersion: 1,
    repositoryDatabaseId,
    headSha,
    observedAt: input.observedAt,
    checks,
    artifacts:
      artifacts.entries.length > 0
        ? { status: "available", entries: artifacts.entries }
        : {
            status: "missing",
            entries: [],
            disposition: missingArtifactGap,
          },
    gaps,
  });
  return {
    archives: artifacts.archives,
    evidence: exactHeadGitHubEvidenceSchema.parse({
      ...payload,
      digest: digestPayload(payload),
    }),
  };
}

export function validateExactHeadGitHubEvidence(
  input: unknown,
  identity: {
    readonly headSha: string;
    readonly repositoryDatabaseId: number;
  },
): ExactHeadGitHubEvidence {
  const evidence = exactHeadGitHubEvidenceSchema.parse(input);
  const { digest, ...payload } = evidence;
  if (
    evidence.headSha !== identity.headSha ||
    evidence.repositoryDatabaseId !== identity.repositoryDatabaseId
  ) {
    throw new GitHubEvidenceError("mismatched-snapshot-identity");
  }
  if (digestPayload(payload) !== digest) {
    throw new GitHubEvidenceError("snapshot-digest-mismatch");
  }
  return evidence;
}
