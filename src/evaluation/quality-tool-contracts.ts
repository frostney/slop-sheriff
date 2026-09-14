import { reviewWorkInputSchema } from "../review/work-execution";
import { reviewWorkReceiptSchema } from "../review/work-receipt";
import { inspectReviewSourceInputSchema } from "../review/source-observations";
import { runReviewProbeInputSchema, readReviewProbeInputSchema } from "../review/probe-execution";
import { z } from "zod";

export const qualityCommonPrefix =
  "Review the frozen corpus claim using the assigned work packet. Do not access later revisions.";
export const qualityWorkTools = {
  review_work: {
    description:
      "Read the assigned packet or persist its complete/progress checkpoint. Identities and proof are application-owned.",
    inputSchema: reviewWorkInputSchema,
  },
  final_output: {
    description: "Return exactly the persisted review_work receipt.",
    inputSchema: reviewWorkReceiptSchema,
  },
  inspect_review_source: {
    description:
      "Read exact base/head source or search tracked text; all supporting observations are recorded.",
    inputSchema: inspectReviewSourceInputSchema,
  },
  run_review_probe: {
    description:
      "Execute a real test or experiment and record its actual inputs, environment and full result.",
    inputSchema: runReviewProbeInputSchema,
  },
  read_review_probe: {
    description: "Read another page of complete recorded test output.",
    inputSchema: readReviewProbeInputSchema,
  },
};
export function qualityWorkToolSchemas() {
  return Object.entries(qualityWorkTools).map(([name, value]) => ({
    type: "function",
    name,
    description: value.description,
    inputSchema: z.toJSONSchema(value.inputSchema, { io: "input" }),
  }));
}
