import { createHash } from "node:crypto";
import type { ReviewConfig } from "../config/review-config";
import { projectLanesSchema } from "./project-lanes";

/** The exact base SHA additionally binds every referenced document's contents. */
export function projectLaneRegistryDigest(config: Pick<ReviewConfig, "lanes">): string | undefined {
  const lanes = projectLanesSchema.parse(config.lanes ?? []);
  return lanes.length ? createHash("sha256").update(JSON.stringify(lanes)).digest("hex") : undefined;
}
