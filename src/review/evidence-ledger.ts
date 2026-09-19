import { createHash } from "node:crypto";
import { z } from "zod";
import type { CapabilityPreflight } from "./capability-preflight";
import {
  commonReviewWorkSchema,
  digestCommonWorkValue,
  type CommonReviewWork,
} from "./common-work";
import { reviewEvidenceManifestSchema, type ReviewEvidenceManifest } from "./evidence-bundle";
import {
  evidenceGapSchema,
  exactHeadGitHubEvidenceSchema,
  type ExactHeadGitHubEvidence,
} from "./github-evidence";

import { requirementSourceSchema, type RequirementSource } from "./requirements";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const commonEvidenceProbeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  command: z.string().min(1).max(500),
  outcome: z.enum(["passed", "failed"]),
  exitCode: z.number().int(),
  stdout: z.string().max(8_000),
  stderr: z.string().max(8_000),
  outputDigest: fingerprintSchema,
});

export type CommonEvidenceProbe = z.infer<typeof commonEvidenceProbeSchema>;

export const reviewEvidenceLedgerIdentitySchema = z.object({
  executionRevision: z.literal("review-evidence-v3"),
  repositoryId: z.string().min(1),
  repositoryDatabaseId: z.number().int().positive(),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  pullRequest: z.number().int().positive(),
  baseSha: revisionSchema,
  headSha: revisionSchema,
  patchFingerprint: fingerprintSchema,
  planKind: z.enum(["full", "delta"]),
});

export type ReviewEvidenceLedgerIdentity = z.infer<
  typeof reviewEvidenceLedgerIdentitySchema
>;

const reviewEvidenceLedgerPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  identity: reviewEvidenceLedgerIdentitySchema,
  components: z.object({
    patchManifestDigest: fingerprintSchema,
    capabilityDigest: fingerprintSchema,
    githubDigest: fingerprintSchema,
    probesDigest: fingerprintSchema,
    commonWorkDigest: fingerprintSchema,
  }),
  github: exactHeadGitHubEvidenceSchema,
  probes: z.array(commonEvidenceProbeSchema),
  gaps: z.array(evidenceGapSchema),
  commonWork: commonReviewWorkSchema,
  requirements: z.array(requirementSourceSchema).optional(),
});

export const reviewEvidenceLedgerSchema = reviewEvidenceLedgerPayloadSchema
  .extend({ digest: fingerprintSchema })
  .superRefine((ledger, context) => {
    const ids = ledger.gaps.map((gap) => gap.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["gaps"],
        message: "Prepared evidence gaps must be unique",
      });
    }
  });

export type ReviewEvidenceLedger = z.infer<typeof reviewEvidenceLedgerSchema>;

export interface ReviewEvidenceLedgerSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  writeTextFile(options: {
    readonly content: string;
    readonly path: string;
  }): PromiseLike<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function reviewEvidenceLedgerPath(patchFingerprint: string): string {
  return `/tmp/known-good-review/evidence/${fingerprintSchema.parse(patchFingerprint)}/ledger.json`;
}

export function prepareCommonProbe(input: {
  readonly command: string;
  readonly exitCode: number;
  readonly id: string;
  readonly stderr: string;
  readonly stdout: string;
}): CommonEvidenceProbe {
  const stdout = input.stdout.slice(0, 8_000);
  const stderr = input.stderr.slice(0, 8_000);
  return commonEvidenceProbeSchema.parse({
    id: input.id,
    command: input.command,
    outcome: input.exitCode === 0 ? "passed" : "failed",
    exitCode: input.exitCode,
    stdout,
    stderr,
    outputDigest: sha256(`${input.exitCode}\0${input.stdout}\0${input.stderr}`),
  });
}

export function assembleReviewEvidenceLedger(input: {
  readonly capabilities: CapabilityPreflight;
  readonly commonWork: CommonReviewWork;
  readonly github: ExactHeadGitHubEvidence;
  readonly identity: ReviewEvidenceLedgerIdentity;
  readonly manifest: ReviewEvidenceManifest;
  readonly probes: readonly CommonEvidenceProbe[];
  readonly requirements?: readonly RequirementSource[];
}): ReviewEvidenceLedger {
  const manifest = reviewEvidenceManifestSchema.parse(input.manifest);
  const identity = reviewEvidenceLedgerIdentitySchema.parse(input.identity);
  if (
    input.manifest.baseSha !== identity.baseSha ||
    input.manifest.headSha !== identity.headSha ||
    input.manifest.patchFingerprint !== identity.patchFingerprint ||
    input.capabilities.baseSha !== identity.baseSha ||
    input.capabilities.headSha !== identity.headSha ||
    input.capabilities.patchFingerprint !== identity.patchFingerprint ||
    input.github.headSha !== identity.headSha ||
    input.github.repositoryDatabaseId !== identity.repositoryDatabaseId
  ) {
    throw new Error("Evidence components do not match the trusted review");
  }
  const probes = z.array(commonEvidenceProbeSchema).parse(input.probes);
  const commonWork = commonReviewWorkSchema.parse(input.commonWork);
  const probeGaps = probes
    .filter((probe) => probe.outcome === "failed")
    .map((probe) =>
      evidenceGapSchema.parse({
        id: `${probe.id}-failed`,
        source: "probe",
        owner: "repository",
        disposition: "check-remedy",
        summary: `Common probe ${probe.id} failed for the exact review head.`,
        remedy: `Run and resolve ${probe.command} in the repository.`,
      }),
    );
  const gaps = [...input.github.gaps, ...probeGaps];
  const payload = reviewEvidenceLedgerPayloadSchema.parse({
    schemaVersion: 2,
    identity,
    components: {
      patchManifestDigest: digestJson(manifest),
      capabilityDigest: input.capabilities.digest,
      githubDigest: input.github.digest,
      probesDigest: digestJson(probes),
      commonWorkDigest: digestCommonWorkValue(commonWork),
    },
    github: input.github,
    probes,
    gaps,
    commonWork,
    requirements: input.requirements ?? [],
  });
  return reviewEvidenceLedgerSchema.parse({
    ...payload,
    digest: digestJson(payload),
  });
}

export function validateReviewEvidenceLedgerComponents(
  ledger: ReviewEvidenceLedger,
  input: {
    readonly capabilities: CapabilityPreflight;
    readonly manifest: ReviewEvidenceManifest;
  },
): void {
  if (
    ledger.components.patchManifestDigest !== digestJson(reviewEvidenceManifestSchema.parse(input.manifest)) ||
    ledger.components.capabilityDigest !== input.capabilities.digest ||
    ledger.components.githubDigest !== ledger.github.digest ||
    ledger.components.probesDigest !== digestJson(ledger.probes) ||
    ledger.components.commonWorkDigest !==
      digestCommonWorkValue(ledger.commonWork)
  ) {
    throw new Error("Prepared evidence components failed ledger validation");
  }
}

export async function validatePreparedArtifactArchives(
  sandbox: {
    readBinaryFile(options: {
      readonly path: string;
    }): PromiseLike<Uint8Array | null>;
  },
  ledger: ReviewEvidenceLedger,
): Promise<void> {
  for (const artifact of ledger.github.artifacts.entries) {
    const archive = await sandbox.readBinaryFile({
      path: `/tmp/known-good-review/evidence/${ledger.identity.patchFingerprint}/${artifact.archiveFile}`,
    });
    if (!archive) {
      throw new Error("Prepared evidence artifact is unavailable");
    }
    const observed = `sha256:${createHash("sha256")
      .update(archive)
      .digest("hex")}`;
    if (observed !== artifact.digest) {
      throw new Error("Prepared evidence artifact failed integrity validation");
    }
  }
}

export async function writeReviewEvidenceLedger(
  sandbox: ReviewEvidenceLedgerSandbox,
  ledger: ReviewEvidenceLedger,
): Promise<void> {
  const parsed = reviewEvidenceLedgerSchema.parse(ledger);
  await sandbox.writeTextFile({
    path: reviewEvidenceLedgerPath(parsed.identity.patchFingerprint),
    content: `${JSON.stringify(parsed)}\n`,
  });
}

export async function readReviewEvidenceLedger(
  sandbox: Pick<ReviewEvidenceLedgerSandbox, "readTextFile">,
  identity: ReviewEvidenceLedgerIdentity,
): Promise<ReviewEvidenceLedger> {
  const exactIdentity = reviewEvidenceLedgerIdentitySchema.parse(identity);
  const source = await sandbox.readTextFile({
    path: reviewEvidenceLedgerPath(exactIdentity.patchFingerprint),
  });
  if (source === null) {
    throw new Error("Prepared evidence ledger is unavailable");
  }
  const ledger = reviewEvidenceLedgerSchema.parse(JSON.parse(source));
  if (JSON.stringify(ledger.identity) !== JSON.stringify(exactIdentity)) {
    throw new Error("Prepared evidence ledger does not match the trusted review");
  }
  const { digest, ...payload } = ledger;
  if (digestJson(payload) !== digest) {
    throw new Error("Prepared evidence ledger failed integrity validation");
  }
  return ledger;
}
