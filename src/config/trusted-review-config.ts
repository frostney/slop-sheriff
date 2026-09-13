import type { SessionAuthContext } from "eve/context";
import { parseReviewConfig, type ReviewConfig } from "./review-config";
import { routingAttribute } from "../models/routing";
import { assertConfiguredLane } from "../review/project-lanes";
import { reviewAxisSchema } from "../review/axes";
import { z } from "zod";

export const trustedVoiceGuideAttribute = "known_good_review_voice_guide";
export function reviewConfigFromAuth(auth: SessionAuthContext | null | undefined): ReviewConfig {
  const source = auth?.attributes[routingAttribute];
  const config = parseReviewConfig(typeof source === "string" ? source : null);
  const guide = auth?.attributes[trustedVoiceGuideAttribute];
  return { ...config, ...(config.voiceGuide && typeof guide === "string" ? { voiceGuideContent: guide } : {}) };
}
export function validateConfiguredAxes(axes: unknown, config: ReviewConfig): void {
  for (const axis of z.array(reviewAxisSchema).parse(axes)) assertConfiguredLane(axis, config);
}
