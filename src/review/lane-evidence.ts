import { requirementObligationIdentities, requirementsForAxis } from "./requirements";
import { readCapabilityPreflight } from "./capability-preflight";
import {
  readNextReviewEvidencePacket,
  type ReviewEvidenceSandbox,
  type ReviewEvidenceManifest,
} from "./evidence-bundle";
import type { ReviewAxis } from "./axes";
import { readLaneCheckpoint, validateLaneCheckpointCoverage } from "./lane-checkpoint";
import {
  readReviewEvidenceLedger,
  validatePreparedArtifactArchives,
  validateReviewEvidenceLedgerComponents,
  type ReviewEvidenceLedgerIdentity,
} from "./evidence-ledger";

export async function readLaneReviewEvidencePacket(
  sandbox: ReviewEvidenceSandbox & {
    readBinaryFile(options: {
      readonly path: string;
    }): PromiseLike<Uint8Array | null>;
  },
  identity: ReviewEvidenceLedgerIdentity,
  manifest: ReviewEvidenceManifest,
  axis: ReviewAxis,
  sessionId: string,
) {
  const ledger = await readReviewEvidenceLedger(sandbox, identity);
  const requirements = requirementsForAxis(ledger.requirements ?? [], axis);
  const capabilityPreflight = await readCapabilityPreflight(sandbox, manifest);
  validateReviewEvidenceLedgerComponents(ledger, {
    capabilities: capabilityPreflight,
    manifest,
  });
  await validatePreparedArtifactArchives(sandbox, ledger);
  const checkpoint = await readLaneCheckpoint(
    sandbox,
    {
      baseSha: identity.baseSha,
      headSha: identity.headSha,
      patchFingerprint: identity.patchFingerprint,
      evidenceDigest: ledger.digest,
    },
    axis,
  );
  if (checkpoint) {
    validateLaneCheckpointCoverage(checkpoint, manifest.entries.length, requirements.map((source) => source.id), requirementObligationIdentities(requirements));
  }
  const packet = await readNextReviewEvidencePacket(
    sandbox,
    manifest,
    axis,
    sessionId,
    checkpoint?.revision ?? 0,
  );
  return {
    ledgerDigest: ledger.digest,
    commonWork: ledger.commonWork,
    requirements,
    github: ledger.github,
    probes: ledger.probes,
    gaps: ledger.gaps,
    capabilityPreflight,
    ...packet,
  };
}
