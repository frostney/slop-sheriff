import { z } from "zod";

export const completedWorkMaxBytes = 2 * 1024 * 1024;
export const workDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const completedWorkKeySchema = z.strictObject({ scopeKey: workDigestSchema, inputDigest: workDigestSchema });
export const completedWorkBindingSchema = completedWorkKeySchema.extend({
  version: z.literal(1), repositoryId: z.string().min(1), pullRequest: z.number().int().positive(),
  sourceAttemptId: z.string().min(1), contentDigest: workDigestSchema,
});
export const completedWorkEnvelopeSchema = z.strictObject({
  binding: completedWorkBindingSchema,
  data: z.string().refine(value => new TextEncoder().encode(value).byteLength <= completedWorkMaxBytes, "Completed work exceeds the storage record limit"),
  signature: workDigestSchema,
});
export type CompletedWorkKey = z.infer<typeof completedWorkKeySchema>;
export type CompletedWorkEnvelope = z.infer<typeof completedWorkEnvelopeSchema>;
