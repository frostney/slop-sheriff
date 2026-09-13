import { createHash } from "node:crypto";
import { z } from "zod";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { inspectReview, lifecycleConfigured } from "../lifecycle/client";
import { artifactBindingPath, artifactBindingSchema, artifactEnvelopeSchema, artifactPathSchema, type ArtifactBinding, type ArtifactEnvelope } from "./durable-evidence-contracts";
import { readAuthenticatedEvidenceArtifact, signEvidenceArtifact, type TextSandbox } from "./authenticated-evidence";
import { reviewEvidenceProgressSchema } from "./evidence-bundle";
import { laneCheckpointSchema } from "./lane-checkpoint";
import { readReviewEvidenceLedger, reviewEvidenceLedgerPath, reviewEvidenceLedgerSchema } from "./evidence-ledger";

export const durableEvidenceReceiptPath = "/tmp/known-good-review/admission.json";

export function artifactBinding(context: TrustedGitHubContext, attemptId = context.deliveryId): ArtifactBinding {
  return artifactBindingSchema.parse({ repositoryId: context.repositoryId, repository: context.repository, pullRequest: context.pullRequest, baseSha: context.baseSha, headSha: context.headSha, patchFingerprint: context.patchFingerprint, reviewPolicyDigest: context.reviewPolicyDigest, attemptId });
}
export async function artifactRequest(operation: string, body: unknown): Promise<unknown> {
  const base = process.env.CONVEX_MEMORY_URL?.replace(/\/$/, "");
  const token = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  if (!base || !token) throw new Error("Durable evidence storage is not configured");
  const response = await fetch(`${base}/review-artifacts/${operation}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Durable evidence ${operation} failed (${response.status})`);
  return response.json();
}
const metadataSchema = z.object({ binding: artifactBindingSchema, rootScope: z.string().min(1), signedBinding: z.string(), recoverySourceAttemptId: z.string().optional() });
function authenticateBinding(envelope: z.infer<typeof metadataSchema>, expected: ArtifactBinding, secret: string | undefined): void {
  const signedBinding = artifactBindingSchema.parse(JSON.parse(readAuthenticatedEvidenceArtifact(artifactBindingPath, envelope.signedBinding, envelope.rootScope, secret)));
  if (JSON.stringify(signedBinding) !== JSON.stringify(expected) || JSON.stringify(artifactBindingSchema.parse(envelope.binding)) !== JSON.stringify(expected)) throw new Error("Durable evidence identity mismatch");
}
export function authenticateArtifact(envelope: ArtifactEnvelope, expected: ArtifactBinding, path: string, secret: string | undefined): string {
  if (envelope.path !== path) throw new Error("Durable evidence path mismatch");
  authenticateBinding(envelope, expected, secret);
  return readAuthenticatedEvidenceArtifact(path, envelope.signedContent, envelope.rootScope, secret);
}
export function envelopeForArtifact(binding: ArtifactBinding, rootScope: string, path: string, content: string, secret: string | undefined): ArtifactEnvelope {
  artifactPathSchema.parse(path);
  return { binding, rootScope, path, signedBinding: signEvidenceArtifact(artifactBindingPath, JSON.stringify(binding), rootScope, secret), signedContent: signEvidenceArtifact(path, content, rootScope, secret) };
}

interface DurableEvidenceDependencies {
  request?: typeof artifactRequest;
  inspect?: typeof inspectReview;
  secret?: string;
}
/** Uses only server-authorized predecessor attempts. Never accepts a root scope from caller input. */
export function durableEvidenceReader(context: TrustedGitHubContext, rootScope: string, dependencies: DurableEvidenceDependencies = {}): TextSandbox {
  const binding = artifactBinding(context);
  const request = dependencies.request ?? artifactRequest;
  const inspect = dependencies.inspect ?? inspectReview;
  const secret = dependencies.secret ?? process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
  let source: Promise<string | undefined> | undefined;
  const read = async (attemptId: string, path: string) => {
    const raw = await request("get", { attemptId, path });
    if (raw === null) return null;
    const envelope = artifactEnvelopeSchema.parse(raw);
    if (attemptId === binding.attemptId && envelope.rootScope !== rootScope) throw new Error("Current evidence root scope mismatch");
    return authenticateArtifact(envelope, artifactBinding(context, attemptId), path, secret);
  };
  const write = async ({ path, content }: { path: string; content: string }) => {
    const checkpoint = path.includes("/checkpoints/") ? laneCheckpointSchema.safeParse(JSON.parse(content)) : null;
    if (checkpoint && !checkpoint.success) throw new Error("Cannot persist an invalid lane checkpoint");
    await request("put", { ...envelopeForArtifact(binding, rootScope, path, content, secret), ...(checkpoint?.success ? { revision: checkpoint.data.revision } : {}) });
  };
  return {
    async readTextFile({ path }) {
      artifactPathSchema.parse(path);
      const current = await read(binding.attemptId, path);
      if (current !== null) return current;
      source ??= inspect(binding.attemptId).then(job => {
        if (!job || job.repositoryId !== binding.repositoryId || job.headSha !== binding.headSha || job.pullRequest !== binding.pullRequest) throw new Error("Evidence recovery attempt is not admitted");
        return job.recoverySourceAttemptId;
      });
      let previous = await source;
      const visited = new Set([binding.attemptId]);
      while (previous) {
        if (visited.has(previous)) throw new Error("Durable evidence recovery ancestry contains a cycle");
        visited.add(previous);
        const recovered = await read(previous, path);
        if (recovered !== null) { await write({ path, content: recovered }); return recovered; }
        const rawMetadata = await request("metadata", { attemptId: previous });
        if (rawMetadata === null) return null;
        const metadata = metadataSchema.parse(rawMetadata);
        authenticateBinding(metadata, artifactBinding(context, previous), secret);
        previous = metadata.recoverySourceAttemptId;
      }
      return null;
    },
    writeTextFile: write,
  };
}

/** Persist an empty, exactly bound application receipt before the first model operation. */
export async function initializeDurableEvidence(context: TrustedGitHubContext, rootScope: string): Promise<void> {
  if (!lifecycleConfigured()) return;
  const reader = durableEvidenceReader(context, rootScope);
  await reader.writeTextFile({ path: durableEvidenceReceiptPath, content: JSON.stringify({ schemaVersion: 1, kind: "admitted", binding: artifactBinding(context) }) });
}

/** Read-only eligibility. Lane reuse still performs the complete checkpoint, coverage and progress validation. */
export async function artifactEligibility(sourceAttemptId: string, expectedContext: TrustedGitHubContext, dependencies: DurableEvidenceDependencies = {}): Promise<{ eligible: boolean; code?: string; completedAxes: string[]; artifactCount: number; progressDigest: string }> {
  const request = dependencies.request ?? artifactRequest;
  const binding = artifactBinding(expectedContext, sourceAttemptId);
  const secret = dependencies.secret ?? process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
  const artifacts = new Map<string, string>();
  const allPaths = new Set<string>();
  let attemptId: string | undefined = sourceAttemptId;
  const visited = new Set<string>();
  while (attemptId) {
    if (visited.has(attemptId)) throw new Error("Durable evidence recovery ancestry contains a cycle");
    visited.add(attemptId);
    const expected = artifactBinding(expectedContext, attemptId);
    let cursor: string | null = null;
    do {
      const page = z.object({ page: z.array(z.object({ path: artifactPathSchema })), isDone: z.boolean(), continueCursor: z.string() }).parse(await request("list", { attemptId, cursor }));
      const relevant = page.page.filter(row => !allPaths.has(row.path) && (row.path === durableEvidenceReceiptPath || row.path.endsWith("/ledger.json") || row.path.includes("/checkpoints/") || row.path.includes("/progress/")));
      for (const row of page.page) allPaths.add(row.path);
      // Eligibility needs semantic progress, not every potentially large patch or archive blob.
      for (let offset = 0; offset < relevant.length; offset += 8) await Promise.all(relevant.slice(offset, offset + 8).map(async row => {
        const raw = await request("get", { attemptId, path: row.path });
        if (raw === null) throw new Error("Durable evidence manifest references a missing artifact");
        artifacts.set(row.path, authenticateArtifact(artifactEnvelopeSchema.parse(raw), expected, row.path, secret));
      }));
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    const rawMetadata = await request("metadata", { attemptId });
    if (rawMetadata === null) break;
    const metadata = metadataSchema.parse(rawMetadata);
    authenticateBinding(metadata, expected, secret);
    attemptId = metadata.recoverySourceAttemptId;
  }
  const completedAxes: string[] = [];
  const semantic: unknown[] = [];
  for (const [path, content] of [...artifacts].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.includes("/progress/")) {
      semantic.push([path, reviewEvidenceProgressSchema.parse(JSON.parse(content))]);
      continue;
    }
    if (!path.includes("/checkpoints/")) continue;
    const checkpoint = laneCheckpointSchema.parse(JSON.parse(content));
    if (checkpoint.baseSha !== binding.baseSha || checkpoint.headSha !== binding.headSha || checkpoint.patchFingerprint !== binding.patchFingerprint) throw new Error("Durable checkpoint identity mismatch");
    const { revision: _revision, nextSteps: _nextSteps, limitations: _limitations, ...progress } = checkpoint;
    semantic.push([path, progress]);
    if (checkpoint.status === "complete") completedAxes.push(checkpoint.axis);
  }
  const ledgerPath = reviewEvidenceLedgerPath(binding.patchFingerprint);
  const rawLedger = artifacts.get(ledgerPath);
  if (rawLedger) {
    const parsed = reviewEvidenceLedgerSchema.parse(JSON.parse(rawLedger));
    for (const field of ["repositoryId", "repository", "pullRequest", "baseSha", "headSha", "patchFingerprint"] as const) if (parsed.identity[field] !== binding[field]) throw new Error("Durable ledger identity mismatch");
    await readReviewEvidenceLedger({ readTextFile: ({ path }) => Promise.resolve(artifacts.get(path) ?? null) }, parsed.identity);
  }
  const receipt = artifacts.get(durableEvidenceReceiptPath);
  if (receipt) {
    const parsed = z.object({ schemaVersion: z.literal(1), kind: z.literal("admitted"), binding: artifactBindingSchema }).parse(JSON.parse(receipt));
    const { attemptId: _receiptAttempt, ...receiptIdentity } = parsed.binding;
    const { attemptId: _expectedAttempt, ...expectedIdentity } = binding;
    if (JSON.stringify(receiptIdentity) !== JSON.stringify(expectedIdentity)) throw new Error("Durable admission identity mismatch");
  }
  // Root scope, signatures, timestamps, preparation reruns and revision-only bumps are not progress.
  const progressDigest = createHash("sha256").update(JSON.stringify([binding.repositoryId, binding.baseSha, binding.headSha, binding.patchFingerprint, binding.reviewPolicyDigest, { prepared: !!rawLedger }, semantic])).digest("hex");
  return { eligible: !!rawLedger || !!receipt, ...(!rawLedger ? { code: receipt ? "admission_only_requires_nonbillable_failure_proof" : "durable_preparation_missing" } : {}), completedAxes, artifactCount: allPaths.size, progressDigest };
}
export { lifecycleConfigured as durableEvidenceConfigured };
