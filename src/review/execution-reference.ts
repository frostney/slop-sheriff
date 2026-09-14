import { z } from "zod";

export const reviewExecutionReferenceSchema = z.union([
  z.strictObject({ kind: z.literal("probe"), id: z.string().uuid() }),
  z.strictObject({ kind: z.literal("external"), id: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export const reviewExecutionReferencesSchema = z.array(reviewExecutionReferenceSchema);
