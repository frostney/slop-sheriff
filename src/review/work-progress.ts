import type { ReviewWorkAssessment } from "./work-results";
import { reviewWorkProofSchema } from "./prepare-review-work";
import { workHash } from "./work-plan";

/** Plans, timestamps and fresh receipt UUIDs cannot masquerade as new investigation. */
export function reviewWorkProgressDigest(assessment: ReviewWorkAssessment): string {
  const { nextSteps: _nextSteps, limitations: _limitations, ...checkpoint } = assessment.checkpoint;
  const proof = reviewWorkProofSchema.parse(assessment.proof);
  const probes = proof.probes.map(({ probeId, input, before, after, status, result, error }) => workHash({ probeId, input, before, after, status, result, error }));
  return workHash({ checkpoint, sources: [...new Set(proof.sources.map(source => source.id))].sort(), probes: [...new Set(probes)].sort(), external: [...new Set(proof.external.map(({ kind, target, outputDigest }) => workHash({ kind, target, outputDigest })))].sort() });
}
