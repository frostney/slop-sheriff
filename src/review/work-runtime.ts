import { z } from "zod";
import { reviewWorkAssessmentSchema } from "./work-results";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewWorkEscalationSchema = z.strictObject({
  difficulty: z.enum(["ambiguous", "conflicting"]),
  reason: z.string().min(1), evidence: z.array(z.string().min(1)).min(1),
});
export { reviewWorkReceiptSchema } from "./work-receipt";

/** Stored through authenticated evidence; no model-provided invocation fields. */
export const reviewWorkResultArtifactSchema = z.strictObject({
  schemaVersion: z.literal(2), attemptId: z.string().min(1),
  assessment: reviewWorkAssessmentSchema,
  escalation: reviewWorkEscalationSchema.nullable().optional(),
  invocation: z.strictObject({ rootSessionId: z.string().min(1), invocationId: z.string().min(1), sessionId: z.string().min(1), turnId: z.string().min(1) }),
});
export const reviewWorkResultPath = (fingerprint: string, workId: string): string =>
  `/tmp/known-good-review/work/${digest.parse(fingerprint)}/${digest.parse(workId)}/result.json`;

export function verifyReviewWorkResult(raw: unknown, input: {
  workId: string; inputDigest: string; rootSessionId: string; invocationId: string; attemptId: string;
}) {
  const result = reviewWorkResultArtifactSchema.parse(raw);
  if (result.attemptId !== input.attemptId || result.assessment.unit.id !== input.workId || result.assessment.inputDigest !== input.inputDigest ||
    result.invocation.rootSessionId !== input.rootSessionId || result.invocation.invocationId !== input.invocationId) {
    throw new Error("Assessment receipt does not belong to this native work invocation");
  }
  return result.assessment;
}
