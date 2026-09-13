import { z } from "zod";
/** Minimal model receipt; all evidence and invocation authority stay in signed artifacts. */
export const reviewWorkReceiptSchema = z.strictObject({ workId: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(["complete", "in-progress"]) });
