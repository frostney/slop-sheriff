import type { ReviewAxis } from "../src/review/axes";
import type { ReviewOrchestrationPlan } from "../src/review/orchestration";
import { workHash } from "../src/review/work-plan";
import { reviewWorkInputDigest } from "../src/review/work-inputs";
import { preparedReviewWorkPacketPath, preparedReviewWorkResultPath, type PreparedReviewWorkPacket } from "../src/review/prepare-review-work";
import { checkpointContent, identity } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";
import type { ReviewWorkAssessment } from "../src/review/work-results";
export function workOrchestrationFixture(axes: readonly ReviewAxis[] = ["engineering-quality", "claim-and-specification"], rootSessionId = "root") {
  const packets = new Map<string, PreparedReviewWorkPacket>();
  const assessments = new Map<string, ReviewWorkAssessment>();
  const units = axes.map(axis => {
    const unit = { id: workHash([axis,"component"]), axis, component: "component", paths: [], requirementIds: [], policyDigest: "e".repeat(64) };
    const inputSnapshot = { schemaVersion: 1 as const, unitId: unit.id, policyDigest: unit.policyDigest, requirementDigest: workHash([]), claimDigest: workHash("fixture"), files: [] };
    const inputDigest = reviewWorkInputDigest(inputSnapshot);
    const packet = { schemaVersion: 1 as const, unit, inputSnapshot, inputDigest, manifest: { schemaVersion: 1 as const, ...identity, entries: [] }, requirements: [], originalClaim: "Fixture", priorAssessment: null, patches: [], reuseInvalidation: null };
    const prepared = { ...unit, inputDigest, packetPath: preparedReviewWorkPacketPath(identity.patchFingerprint, unit.id), resultPath: preparedReviewWorkResultPath(identity.patchFingerprint, unit.id), status: "pending" as const, reusableAssessment: null };
    packets.set(unit.id, packet);
    assessments.set(unit.id, { schemaVersion: 1, unit, inputDigest, sourceBaseSha: identity.baseSha, sourceHeadSha: identity.headSha, proof: { schemaVersion: 2, inputSnapshot, sources: [], probes: [], external: [] }, checkpoint: checkpointContent(axis) });
    return prepared;
  });
  const plan: ReviewOrchestrationPlan = { prepared: { schemaVersion: 1, baseSha: identity.baseSha, headSha: identity.headSha, patchFingerprint: identity.patchFingerprint, units }, activeAxes: axes, commonPrefix: "Fixture", rootSessionId, attemptId:"fixture-attempt" };
  const files = new Map(units.map(unit => [unit.packetPath, JSON.stringify(packets.get(unit.id))]));
  const reader = { async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; }, async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); } };
  return { plan, packets, assessments, files, reader };
}
