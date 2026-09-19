import { projectLaneRegistryDigest } from "../../src/review/project-lane-identity";
import { reviewConfigFromAuth } from "../../src/config/trusted-review-config";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import type { ReviewEvidenceLedgerIdentity } from "../../src/review/evidence-ledger";
import { readReviewEvidenceLedger } from "../../src/review/evidence-ledger";
import type { LaneCheckpointIdentity } from "../../src/review/lane-checkpoint";

const planSchema = z.object({ kind: z.enum(["full", "delta"]) });

export function currentReviewEvidenceIdentity(
  auth: SessionAuthContext | null | undefined,
): ReviewEvidenceLedgerIdentity {
  const trusted = trustedGitHubContext(auth);
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review context is missing the patch fingerprint");
  }
  if (!trusted.repositoryDatabaseId) {
    throw new Error(
      "Trusted review context is missing the repository database id",
    );
  }
  const rawPlan = auth?.attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") {
    throw new Error("Trusted review context is missing the review plan");
  }
  const plan = planSchema.parse(JSON.parse(rawPlan));
  return {
    executionRevision: "review-evidence-v3",
    repositoryId: trusted.repositoryId,
    repositoryDatabaseId: trusted.repositoryDatabaseId,
    repository: trusted.repository,
    pullRequest: trusted.pullRequest,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    planKind: plan.kind,
  };
}

export async function currentLaneCheckpointIdentity(
  auth: SessionAuthContext | null | undefined,
  sandbox: {
    readTextFile(options: {
      readonly path: string;
    }): PromiseLike<string | null>;
  },
): Promise<LaneCheckpointIdentity> {
  const identity = currentReviewEvidenceIdentity(auth);
  const ledger = await readReviewEvidenceLedger(sandbox, identity);
  return {
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    patchFingerprint: identity.patchFingerprint,
    evidenceDigest: ledger.digest,
    laneRegistryDigest: projectLaneRegistryDigest(reviewConfigFromAuth(auth)),
  };
}
