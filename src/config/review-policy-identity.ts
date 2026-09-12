import { createHash } from "node:crypto";
import { parseReviewConfig } from "./review-config";

/** Base identity binds unchanged requirements and all referenced documents. */
export function reviewPolicyDigest(configSource: string, baseSha: string): string {
  return createHash("sha256").update(JSON.stringify({ revision: "review-policy-v4", baseSha, config: parseReviewConfig(configSource) })).digest("hex");
}
