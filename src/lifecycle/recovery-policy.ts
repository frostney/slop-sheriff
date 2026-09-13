import { z } from "zod";
import { reviewPolicyDigest } from "../config/review-policy-identity";
import { trustedGitHubContext, type TrustedGitHubContext } from "../github/trusted-context";
import { routingAttribute } from "../models/routing";

const savedAuthSchema = z.object({
  authenticator: z.string(), principalId: z.string(), principalType: z.string(),
  attributes: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

/** The base revision fixes config contents; the current runtime fixes review policy. */
export function recoveryPolicy(savedAuth: string | undefined, expected: TrustedGitHubContext): { reuse: boolean; digest: string } {
  if (!savedAuth) throw new Error("Recovery is missing its trusted configuration snapshot");
  const auth = savedAuthSchema.parse(JSON.parse(savedAuth));
  const prior = trustedGitHubContext(auth);
  for (const field of ["repositoryId", "repository", "pullRequest", "baseSha", "headSha", "patchFingerprint", "reviewPolicyDigest"] as const) {
    if (prior[field] !== expected[field]) throw new Error("Recovery configuration does not match the interrupted review");
  }
  const configSource = auth.attributes[routingAttribute];
  if (typeof configSource !== "string") throw new Error("Recovery configuration source is missing");
  const digest = reviewPolicyDigest(configSource, expected.baseSha);
  return { reuse: digest === expected.reviewPolicyDigest, digest };
}
