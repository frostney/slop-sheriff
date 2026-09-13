import { createHash } from "node:crypto";
import { parseReviewConfig } from "./review-config";
import { reviewAxes } from "../review/axes";
import { reviewInstructions, reviewChildInstructions, reviewTaskInstructions, reviewVoiceInstructions } from "../review/policy";

/** Base identity binds unchanged requirements and all referenced documents. */
export function reviewPolicyDigest(configSource: string, baseSha: string): string {
  const config = parseReviewConfig(configSource);
  const runtimePolicy = [
    reviewInstructions({ role: "coordinator", attempt: 0 }), reviewChildInstructions(),
    ...reviewAxes.map(axis => reviewTaskInstructions({ role: "lane", axis, attempt: 0 })),
    reviewTaskInstructions({ role: "lane", axis: "project-policy", attempt: 0 }),
    reviewTaskInstructions({ role: "scout", attempt: 0 }),
    reviewTaskInstructions({ role: "revalidation", attempt: 0 }), reviewVoiceInstructions(config),
  ];
  return createHash("sha256").update(JSON.stringify({ revision: "review-policy-v5", baseSha, config, runtimePolicy })).digest("hex");
}
