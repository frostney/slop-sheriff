import { z } from "zod";
import { reviewFindingRevalidationSchema } from "./findings";
import { reviewReportDraftSchema } from "./report-assembly";

export const assembleReviewReportInputSchema = z
  .strictObject({
    draft: reviewReportDraftSchema,
  });

export const recordReviewRevalidationInputSchema = z
  .strictObject({
    findings: z.array(reviewFindingRevalidationSchema).max(100),
  });
