import { z } from "zod";
import { reviewFindingRevalidationSchema } from "./findings";
import { reviewAdjudicationDraftSchema } from "./adjudication";

export const assembleReviewReportInputSchema = z
  .strictObject({
    draft: reviewAdjudicationDraftSchema,
  });

export const recordReviewRevalidationInputSchema = z
  .strictObject({
    findings: z.array(reviewFindingRevalidationSchema).max(100),
  });
