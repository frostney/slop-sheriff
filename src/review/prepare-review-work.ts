import { z } from "zod";
import { validateWorkExecutionReferences } from "./execution-evidence";
import type { TextSandbox } from "./authenticated-evidence";
import type { TrustedGitHubContext } from "../github/trusted-context";
import type { ReviewConfig } from "../config/review-config";
import type { ReviewAxisDecision } from "./axis-selection";
import { reviewEvidenceManifestSchema, reviewEvidenceDirectory, repositoryPathSchema, type ReviewEvidenceManifest } from "./evidence-bundle";
import { requirementSourceSchema, requirementObligationIdentities, type RequirementSource } from "./requirements";
import { buildReviewWorkPlan, reviewWorkPlanSchema, reviewWorkPlanPath, reviewWorkUnitSchema, workUnitManifest, type ReviewWorkUnit } from "./work-plan";
import { readWorkRevisionTree, reviewWorkInputDigest, snapshotReviewWorkInputs, workInputSnapshotSchema, type WorkInputSnapshot, type WorkInputSandbox } from "./work-inputs";
import { reviewWorkAssessmentSchema, validateWorkAssessment, workProgressScopeKey, type ReviewWorkAssessment } from "./work-results";
import { completedReviewWorkStore } from "./work-storage";
import { lifecycleConfigured } from "../lifecycle/client";
import { sourceObservationSchema, readWorkSourceObservations, validateSourceObservations } from "./source-observations";
import { reviewProbeReceiptSchema, readWorkProbeReceipts, readWorkProbeConsumption, validateCurrentWorkProbeReceipts, validateWorkProbeReceipts } from "./probe-execution";
import { externalObservationSchema, readWorkExternalObservations, validateCurrentExternalObservations } from "./external-observations";
import { projectEmbeddedMediaPatch } from "./embedded-media";
import { createHash } from "node:crypto";
import { reportRepositoryDigest } from "./report-repository-identity";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
export type ReviewWorkSandbox = TextSandbox & WorkInputSandbox;
export const preparedReviewWorkPacketPath = (patch: string, unit: string) => `/tmp/known-good-review/work/${fingerprint.parse(patch)}/${fingerprint.parse(unit)}/packet.json`;
export const preparedReviewWorkResultPath = (patch: string, unit: string) => `/tmp/known-good-review/work/${fingerprint.parse(patch)}/${fingerprint.parse(unit)}/result.json`;

export const reviewWorkProofSchema = z.strictObject({
  schemaVersion: z.literal(2), inputSnapshot: workInputSnapshotSchema,
  sources: z.array(sourceObservationSchema), probes: z.array(reviewProbeReceiptSchema), external: z.array(externalObservationSchema),
});
export const preparedReviewWorkPacketSchema = z.strictObject({
  schemaVersion: z.literal(1), unit: reviewWorkUnitSchema,
  inputSnapshot: workInputSnapshotSchema, inputDigest: fingerprint,
  manifest: reviewEvidenceManifestSchema,
  requirements: z.array(z.strictObject({ source: requirementSourceSchema, baseText: z.string().nullable(), headText: z.string().nullable() })),
  originalClaim: z.string(), priorAssessment: reviewWorkAssessmentSchema.nullable(),
  patches: z.array(z.strictObject({ path: repositoryPathSchema, content: z.string(), fromHead: revision.nullable() })),
  reuseInvalidation: z.string().nullable(),
});
export type PreparedReviewWorkPacket = z.infer<typeof preparedReviewWorkPacketSchema>;
export const preparedReviewWorkPlanSchema = reviewWorkPlanSchema.extend({
  reportRepositoryDigest: fingerprint.nullable().optional(),
  units: z.array(reviewWorkUnitSchema.extend({ inputDigest: fingerprint, packetPath: z.string(), resultPath: z.string(),
    status: z.enum(["pending", "reused"]), reusableAssessment: reviewWorkAssessmentSchema.nullable() })),
});
export type PreparedReviewWorkPlan = z.infer<typeof preparedReviewWorkPlanSchema>;

export function reviewWorkPlanFromPrepared(prepared: PreparedReviewWorkPlan) {
  const { reportRepositoryDigest: _repositoryDigest, ...plan } = prepared;
  return reviewWorkPlanSchema.parse({ ...plan, units: prepared.units.map(({ inputDigest: _digest, packetPath: _packet, resultPath: _result, status: _status, reusableAssessment: _reused, ...unit }) => unit) });
}

/** Completion tools capture these receipts; models never supply proof identities. */
export async function captureReviewWorkProof(sandbox: TextSandbox, patch: string, unit: ReviewWorkUnit, inputSnapshot: WorkInputSnapshot, attemptId: string) {
  const consumption = await readWorkProbeConsumption(sandbox, patch, unit.id);
  const consumed = new Set(consumption.filter(item => item.attemptId === attemptId).map(item => item.receiptDigest));
  return reviewWorkProofSchema.parse({ schemaVersion: 2, inputSnapshot,
    sources: await readWorkSourceObservations(sandbox, patch, unit.id),
    // Same-head recovery retains immutable history. Completion binds only the
    // observations this admitted attempt actually executed or explicitly reused.
    probes: (await readWorkProbeReceipts(sandbox, patch, unit.id)).filter(receipt => consumed.has(receipt.digest)),
    external: await readWorkExternalObservations(sandbox, patch, unit.id),
  });
}

/** Missing/unknown proof invalidates reuse. Valid proof always checks actual source and execution observations. */
export async function validateReviewWorkProof(sandbox: ReviewWorkSandbox, identity: { baseSha: string; headSha: string }, setup: unknown,
  assessment: ReviewWorkAssessment, inputSnapshot: WorkInputSnapshot): Promise<boolean> {
  const parsed = reviewWorkProofSchema.safeParse(assessment.proof);
  if (!parsed.success || reviewWorkInputDigest(parsed.data.inputSnapshot) !== reviewWorkInputDigest(inputSnapshot)) return false;
  if (!validateWorkExecutionReferences(assessment.checkpoint.completedReport, parsed.data.probes, parsed.data.external)) return false;
  if (parsed.data.external.length > 0) return false;
  if (!await validateSourceObservations(sandbox, identity, parsed.data.sources)) return false;
  if (parsed.data.probes.length && !await validateWorkProbeReceipts(sandbox, setup, parsed.data.probes)) return false;
  return true;
}

/** Completion validates the observations actually consumed in this admitted attempt.
 * Fresh checks and fixture writes are evidence even when their results cannot be reused. */
export async function validateCurrentReviewWorkProof(sandbox: ReviewWorkSandbox, identity: { baseSha: string; headSha: string; patchFingerprint: string }, _setup: unknown,
  assessment: ReviewWorkAssessment, inputSnapshot: WorkInputSnapshot, attemptId: string): Promise<boolean> {
  const parsed = reviewWorkProofSchema.safeParse(assessment.proof);
  if (!parsed.success || reviewWorkInputDigest(parsed.data.inputSnapshot) !== reviewWorkInputDigest(inputSnapshot)) return false;
  // Historical web/image context remains in the proof to prevent future reuse,
  // but only observations made in this attempt can support current execution claims.
  const currentExternal = parsed.data.external.filter(observation => observation.attemptId === attemptId);
  if (!validateWorkExecutionReferences(assessment.checkpoint.completedReport, parsed.data.probes, currentExternal)) return false;
  const actual = await captureReviewWorkProof(sandbox, identity.patchFingerprint, assessment.unit, inputSnapshot, attemptId);
  const ids = (values: readonly string[]) => JSON.stringify([...values].sort());
  if (ids(actual.sources.map(item => item.id)) !== ids(parsed.data.sources.map(item => item.id)) ||
    ids(actual.probes.map(item => item.digest)) !== ids(parsed.data.probes.map(item => item.digest)) ||
    ids(actual.external.map(item => item.id)) !== ids(parsed.data.external.map(item => item.id))) return false;
  if (!await validateSourceObservations(sandbox, identity, parsed.data.sources)) return false;
  if (!await validateCurrentWorkProbeReceipts(sandbox, attemptId, parsed.data.probes,
    await readWorkProbeConsumption(sandbox, identity.patchFingerprint, assessment.unit.id))) return false;
  return validateCurrentExternalObservations(sandbox, attemptId, currentExternal);
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type WorkStore = Pick<ReturnType<typeof completedReviewWorkStore>, "get" | "latest">;
export interface PrepareReviewWorkInput {
  readonly manifest: ReviewEvidenceManifest;
  readonly requirements: readonly RequirementSource[];
  readonly decisions: readonly ReviewAxisDecision[];
  readonly config: Pick<ReviewConfig, "lanes">;
  readonly claim: string;
  readonly setup?: unknown;
}

async function readRequirementBlob(sandbox: WorkInputSandbox, blob: string | null): Promise<string | null> {
  if (blob === null) return null;
  const result = await sandbox.run({ command: `cd /workspace && git cat-file blob ${revision.parse(blob)}` });
  if (result.exitCode !== 0) throw new Error("Could not read an exact requirement source for review work");
  return String(result.stdout);
}

export async function prepareReviewWork(sandbox: ReviewWorkSandbox, trusted: TrustedGitHubContext, input: PrepareReviewWorkInput,
  dependencies: { readonly store?: WorkStore | null } = {}): Promise<PreparedReviewWorkPlan> {
  const manifest = reviewEvidenceManifestSchema.parse(input.manifest);
  if (manifest.baseSha !== trusted.baseSha || manifest.headSha !== trusted.headSha || manifest.patchFingerprint !== trusted.patchFingerprint) throw new Error("Prepared work manifest does not match trusted review identity");
  const plan = buildReviewWorkPlan(input);
  const [base, head] = await Promise.all([readWorkRevisionTree(sandbox, trusted.baseSha), readWorkRevisionTree(sandbox, trusted.headSha)]);
  const store = dependencies.store === undefined ? lifecycleConfigured() ? completedReviewWorkStore(trusted) : null : dependencies.store;
  const units: PreparedReviewWorkPlan["units"] = [];
  const requirementText = new Map<string, Promise<{ source: RequirementSource; baseText: string | null; headText: string | null }>>();
  for (const unit of plan.units) {
    const inputSnapshot = snapshotReviewWorkInputs({ unit, base, head, requirements: input.requirements, claim: input.claim });
    const inputDigest = reviewWorkInputDigest(inputSnapshot);
    const exact = await store?.get({ scopeKey: unit.id, inputDigest }) ?? null;
    const historical = exact ?? await store?.latest({ scopeKey: unit.id }) ?? await store?.latest({ scopeKey: workProgressScopeKey(unit) }) ?? null;
    let historicalValue: unknown = null;
    if (historical) { try { historicalValue = JSON.parse(historical.data); } catch { /* An older or malformed contract cannot establish reusable work. */ } }
    const prior = historical ? reviewWorkAssessmentSchema.safeParse(historicalValue) : null;
    const priorAssessment = prior?.success && prior.data.unit.id === unit.id ? prior.data : null;
    let reusableAssessment: ReviewWorkAssessment | null = null;
    let reuseInvalidation: string | null = priorAssessment ? "Source inputs, requirements, policy or supporting evidence changed." : historical ? "Historical work uses an unknown assessment contract." : null;
    if (priorAssessment && priorAssessment.inputDigest === inputDigest) {
      // Keep actual I/O outside semantic-validation recovery. A storage, Git or
      // execution failure must not silently become another paid assessment.
      const proofValid = await validateReviewWorkProof(sandbox, trusted, input.setup, priorAssessment, inputSnapshot);
      try {
        reusableAssessment = await validateWorkAssessment(priorAssessment, unit, { inputDigest,
          obligations: requirementObligationIdentities(input.requirements), requireComplete: true,
          validateProof: async () => proofValid,
        });
        reuseInvalidation = null;
      } catch { /* A structurally valid historical record may fail current coverage or proof rules. */ }
    }
    const requirements = await Promise.all(input.requirements.filter(source => unit.requirementIds.includes(source.id)).map(source => {
      let pending = requirementText.get(source.id);
      if (!pending) {
        pending = source.kind === "lane-criteria"
          ? Promise.resolve({ source, baseText: input.config.lanes?.find(lane => source.laneIds.includes(lane.id))?.criteria ?? null, headText: null })
          : Promise.all([readRequirementBlob(sandbox, source.baseBlob), readRequirementBlob(sandbox, source.headBlob)]).then(([baseText, headText]) => ({ source, baseText, headText }));
        requirementText.set(source.id, pending);
      }
      return pending;
    }));
    const patches: PreparedReviewWorkPacket["patches"] = [];
    for (const entry of workUnitManifest(manifest, unit).entries) {
      if (entry.kind === "excluded") { patches.push({ path: entry.path, content: `Excluded payload: ${entry.classification.join(", ")}. Added ${entry.addedLines}, removed ${entry.deletedLines} lines. Inspect the actual artifact when relevant.`, fromHead: null }); continue; }
      let raw: string;
      let fromHead: string | null = null;
      if (priorAssessment && priorAssessment.sourceHeadSha !== trusted.headSha) {
        const previous = revision.parse(priorAssessment.sourceHeadSha);
        const exists = await sandbox.run({ command: `cd /workspace && printf '%s\\n' ${previous} | git cat-file --batch-check='%(objecttype)'` });
        if (exists.exitCode !== 0) throw new Error("Could not inspect the historical review revision");
        if (String(exists.stdout).trim() === "commit") {
          const delta = await sandbox.run({ command: `cd /workspace && git --literal-pathspecs diff --no-ext-diff --no-textconv --full-index ${previous} ${revision.parse(trusted.headSha)} -- ${quote(entry.path)}` });
          if (delta.exitCode !== 0) throw new Error("Could not prepare incremental review work patch");
          raw = String(delta.stdout); fromHead = previous;
        } else raw = await readRawPreparedPatch(sandbox, manifest, entry);
      } else raw = await readRawPreparedPatch(sandbox, manifest, entry);
      const rawPatchPath = `/tmp/known-good-review/work/${manifest.patchFingerprint}/${unit.id}/${createHash("sha256").update(entry.path).digest("hex")}.patch`;
      await sandbox.writeTextFile({ path: rawPatchPath, content: raw });
      patches.push({ path: entry.path, content: projectEmbeddedMediaPatch(raw, { path: entry.path, rawPatchPath }), fromHead });
    }
    const packetPath = preparedReviewWorkPacketPath(manifest.patchFingerprint, unit.id);
    const resultPath = preparedReviewWorkResultPath(manifest.patchFingerprint, unit.id);
    const packet = preparedReviewWorkPacketSchema.parse({ schemaVersion: 1, unit, inputSnapshot, inputDigest,
      manifest: workUnitManifest(manifest, unit), requirements, originalClaim: input.claim, priorAssessment, patches, reuseInvalidation });
    await sandbox.writeTextFile({ path: packetPath, content: JSON.stringify(packet) });
    units.push({ ...unit, inputDigest, packetPath, resultPath, status: reusableAssessment ? "reused" : "pending", reusableAssessment });
  }
  const repositoryDigest = await reportRepositoryDigest({ sandbox, base, head, requirements: input.requirements, setup: input.setup });
  const prepared = preparedReviewWorkPlanSchema.parse({ ...plan, units, reportRepositoryDigest: repositoryDigest });
  await sandbox.writeTextFile({ path: reviewWorkPlanPath(manifest.patchFingerprint), content: JSON.stringify(prepared) });
  return prepared;
}

async function readRawPreparedPatch(sandbox: TextSandbox, manifest: ReviewEvidenceManifest, entry: Extract<ReviewEvidenceManifest["entries"][number], { kind: "included" }>): Promise<string> {
  const raw = await sandbox.readTextFile({ path: `${reviewEvidenceDirectory(manifest.patchFingerprint)}/${entry.patchFile}` });
  if (raw === null || createHash("sha256").update(raw).digest("hex") !== entry.patchSha256) throw new Error("Prepared work patch failed integrity validation");
  return raw;
}
