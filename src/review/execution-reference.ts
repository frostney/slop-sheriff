import { z } from "zod";

// Eve reconstructs serialized schemas before the SDK exports them. Keeping the
// UUID pattern without a second format constraint avoids an unsupported allOf.
export const probeExecutionIdSchema = z.string().regex(z.regexes.uuid());

export const reviewExecutionReferenceSchema = z.union([
  z.strictObject({ kind: z.literal("probe"), id: probeExecutionIdSchema }),
  z.strictObject({ kind: z.literal("external"), id: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export const reviewExecutionReferencesSchema = z.array(reviewExecutionReferenceSchema);
