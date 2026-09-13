import { projectLaneRegistryDigest } from "../../src/review/project-lane-identity";
import { reviewConfigFromAuth, validateConfiguredAxes } from "../../src/config/trusted-review-config";
import { defineState, type SessionAuthContext } from "eve/context";
import { z } from "zod";
import { reviewContextAttributes, trustedGitHubContext } from "../../src/github/trusted-context";
import { reviewAxisSchema, maxReviewLanes } from "../../src/review/axes";
import {
  beginReviewRecovery,
  validateReviewRecoveryIdentity,
  type ReviewRecoveryState,
} from "../../src/review/recovery";

const trustedRecoveryPlanSchema = z.object({
  kind: z.enum(["full", "delta"]),
  activeAxes: z.array(reviewAxisSchema).min(1).max(maxReviewLanes),
  selectedFindingIds: z.array(z.string().regex(/^CR-[1-9]\d*$/)).max(100),
});

export const reviewRecoveryState = defineState<ReviewRecoveryState | null>(
  "known-good-review.recovery",
  () => null,
);

export function recoveryStateFromAuth(
  auth: SessionAuthContext | null | undefined,
): ReviewRecoveryState {
  const trusted = trustedGitHubContext(auth);
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review recovery is missing patch identity");
  }
  const rawPlan = auth?.attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") {
    throw new Error("Trusted review recovery is missing its plan");
  }
  const plan = trustedRecoveryPlanSchema.parse(JSON.parse(rawPlan));
  validateConfiguredAxes(plan.activeAxes, reviewConfigFromAuth(auth));
  return beginReviewRecovery({
    activeAxes: plan.activeAxes,
    identity: {
      baseSha: trusted.baseSha,
      headSha: trusted.headSha,
      patchFingerprint: trusted.patchFingerprint,
      laneRegistryDigest: projectLaneRegistryDigest(reviewConfigFromAuth(auth)),
      planKind: plan.kind,
    },
    selectedFindingIds: plan.selectedFindingIds,
  });
}

export function currentRecoveryState(
  auth: SessionAuthContext | null | undefined,
): ReviewRecoveryState {
  const current = reviewRecoveryState.get();
  if (current) {
    const trusted = trustedGitHubContext(auth);
    if (!trusted.patchFingerprint) {
      throw new Error("Trusted review recovery is missing patch identity");
    }
    const rawPlan = auth?.attributes[reviewContextAttributes.plan];
    if (typeof rawPlan !== "string") {
      throw new Error("Trusted review recovery is missing its plan");
    }
    const plan = z.object({ kind: z.enum(["full", "delta"]) }).parse(
      JSON.parse(rawPlan),
    );
    const expected = recoveryStateFromAuth(auth);
    if (JSON.stringify(current.activeAxes) !== JSON.stringify(expected.activeAxes) || JSON.stringify(current.selectedFindingIds) !== JSON.stringify(expected.selectedFindingIds)) throw new Error("Recovery work does not match the trusted review plan");
    return validateReviewRecoveryIdentity(current, {
      baseSha: trusted.baseSha,
      headSha: trusted.headSha,
      patchFingerprint: trusted.patchFingerprint,
      laneRegistryDigest: projectLaneRegistryDigest(reviewConfigFromAuth(auth)),
      planKind: plan.kind,
    });
  }
  const started = recoveryStateFromAuth(auth);
  reviewRecoveryState.update(() => started);
  return started;
}
