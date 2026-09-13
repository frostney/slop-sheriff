import type { SessionContext } from "eve/context";
import { authenticatedEvidenceSandbox } from "../../../../../src/review/authenticated-evidence";
import type { ReviewAxis } from "../../../../../src/review/axes";
import { isSpecialistAxis } from "../../../../../src/review/specialist-scope";
import type { LaneCheckpointContent } from "../../../../../src/review/lane-checkpoint";

export const identity = { baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64), evidenceDigest: "d".repeat(64) };
export const activeAxes: ReviewAxis[] = ["deduplication", "claim-and-specification", "engineering-quality"];
export async function evidenceSandbox(ctx: Pick<SessionContext, "session" | "getSandbox">) {
  return authenticatedEvidenceSandbox(await ctx.getSandbox(), ctx.session.parent?.rootSessionId ?? ctx.session.id, "1".repeat(64));
}
export function checkpointContent(axis: ReviewAxis, incomplete = false): LaneCheckpointContent {
  return {
    status: incomplete ? "in-progress" : "complete", reviewedEntries: [], remainingEntries: [], observations: [],
    nextSteps: incomplete ? ["Inspect the scout's bounded evidence in fresh context."] : [], limitations: [],
    completedReport: incomplete ? null : {
      axis, scope: { claim: "Synthetic runtime checkpoint", dirtyState: "clean", inspectedSupportingContext: [] },
      coverage: { staticOnly: ["Synthetic fixture has no repository changes."], unreached: [] },
      churn: { window: "Fixture", symbolCoverage: [], fileFallbacks: [] }, probes: [], candidates: [], verifiedClaims: [], limitations: [],
      specialistChecks: isSpecialistAxis(axis) ? [] : null,
    },
  };
}

// Synthetic trusted-base data exercises the production parser and protocol.
export const runtimeProjectConfig = `lanes:
  - id: project-api
    name: API compatibility
    criteria: Preserve the documented wire envelope.
    always: true
  - id: project-accessibility
    name: Accessible controls
    criteria: Every interactive control has an accessible name.
    always: true
`;
