import { z } from "zod";

export const artifactBindingSchema = z.strictObject({
  repositoryId: z.string().min(1), repository: z.string().min(1), pullRequest: z.number().int().positive(),
  baseSha: z.string().min(1), headSha: z.string().min(1), patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/), attemptId: z.string().min(1),
});
export type ArtifactBinding = z.infer<typeof artifactBindingSchema>;
export const artifactPathSchema = z.string().startsWith("/tmp/known-good-review/").refine(path => !path.split("/").some(part => part === "." || part === "..") && !path.includes("\0"));
export const artifactEnvelopeSchema = z.strictObject({
  binding: artifactBindingSchema, rootScope: z.string().min(1), signedBinding: z.string(),
  path: artifactPathSchema, signedContent: z.string(),
});
export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;
export const artifactBindingPath = "/tmp/known-good-review/durable-binding.json";
