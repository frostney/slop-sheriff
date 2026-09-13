import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { evidenceSigningKey } from "./authenticated-evidence";
import { reviewAxisSchema } from "./axes";
import type { ReviewEvidenceProgress } from "./evidence-bundle";
import type { LaneCheckpoint } from "./lane-checkpoint";

const attestationSchema = z.strictObject({
  version: z.literal(2), rootSessionId: z.string().min(1), invocationId: z.string().min(1),
  axis: reviewAxisSchema, attempt: z.number().int().nonnegative(), operation: z.enum(["read", "write"]),
  baseSha: z.string(), headSha: z.string(), patchFingerprint: z.string(), evidenceDigest: z.string(),
  laneRegistryDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  revision: z.number().int().positive(), status: z.enum(["complete", "in-progress"]),
  progressDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CheckpointAttestation = z.infer<typeof attestationSchema>;

/** Only authenticated checkpoint tools mint this receipt; no key enters model or sandbox. */
export function attestCheckpoint(input: {
  readonly checkpoint: LaneCheckpoint; readonly rootSessionId: string; readonly invocationId: string;
  readonly evidenceProgress?: ReviewEvidenceProgress;
  readonly attempt: number; readonly operation: "read" | "write"; readonly secret: string | undefined;
}): string {
  const checkpoint = input.checkpoint;
  // Plans and limitations can be rephrased without investigating anything.
  // Progress retains observations and application-recorded packet movement.
  const { revision: _revision, nextSteps: _nextSteps, limitations: _limitations, ...progress } = checkpoint;
  const payload = attestationSchema.parse({
    version: 2, rootSessionId: input.rootSessionId, invocationId: input.invocationId,
    axis: checkpoint.axis, attempt: input.attempt, operation: input.operation,
    baseSha: checkpoint.baseSha, headSha: checkpoint.headSha, patchFingerprint: checkpoint.patchFingerprint,
    laneRegistryDigest: checkpoint.laneRegistryDigest,
    evidenceDigest: checkpoint.evidenceDigest, revision: checkpoint.revision, status: checkpoint.status,
    progressDigest: createHash("sha256").update(JSON.stringify({ checkpoint: progress, evidenceProgress: input.evidenceProgress ?? null })).digest("hex"),
    checkpointDigest: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex"),
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", evidenceSigningKey(input.secret)).update("review-checkpoint-attestation-v2\0").update(encoded).digest("hex");
  return `${encoded}.${signature}`;
}

export function verifyCheckpointAttestation(token: string, expected: Pick<CheckpointAttestation,
  "rootSessionId" | "invocationId" | "axis" | "attempt" | "baseSha" | "headSha" | "patchFingerprint" | "laneRegistryDigest"
>, secret: string | undefined): CheckpointAttestation {
  const parts = token.split(".");
  const encoded = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || !encoded || !signature || !/^[a-f0-9]{64}$/.test(signature)) throw new Error("Invalid checkpoint attestation");
  const actual = createHmac("sha256", evidenceSigningKey(secret)).update("review-checkpoint-attestation-v2\0").update(encoded).digest();
  if (!timingSafeEqual(Buffer.from(signature, "hex"), actual)) throw new Error("Checkpoint attestation authentication failed");
  const payload = attestationSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  for (const field of ["rootSessionId", "invocationId", "axis", "attempt", "baseSha", "headSha", "patchFingerprint", "laneRegistryDigest"] as const) {
    if (payload[field] !== expected[field]) throw new Error(`Checkpoint attestation ${field} mismatch`);
  }
  return payload;
}
