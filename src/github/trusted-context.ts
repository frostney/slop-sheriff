import { reviewPolicyDigest } from "../config/review-policy-identity";
import { z } from "zod";
import type { SessionAuthContext } from "eve/context";
import { trustedVoiceGuideAttribute } from "../config/trusted-review-config";
import { routingAttribute } from "../models/routing";

export const reviewContextAttributes = {
  baseSha: "known_good_review_base_sha",
  reviewPolicyDigest: "known_good_review_policy_digest",
  event: "known_good_review_event",
  headSha: "known_good_review_head_sha",
  memoryAdmission: "known_good_review_memory_admission",
  patchFingerprint: "known_good_review_patch_fingerprint",
  plan: "known_good_review_plan",
  reviewFiles: "known_good_review_files",
  repositoryCreatedAt: "known_good_review_repository_created_at",
  repositoryDatabaseId: "known_good_review_repository_database_id",
  repositoryId: "known_good_review_repository_id",
} as const;

const trustedGitHubContextSchema = z.object({
  installationId: z.coerce.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullRequest: z.coerce.number().int().positive(),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  repositoryCreatedAt: z.coerce.number().int().nonnegative(),
  repositoryDatabaseId: z.coerce.number().int().positive().optional(),
  repositoryId: z.string().min(1),
  baseSha: z.string().min(1),
  reviewPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  headSha: z.string().min(1),
  memoryAdmission: z.string().min(1).optional(),
  patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export type TrustedGitHubContext = z.infer<typeof trustedGitHubContextSchema>;

export function withTrustedReviewContext(
  auth: SessionAuthContext,
  values: {
    readonly baseSha: string;
    readonly configSource: string;
    readonly voiceGuideContent?: string;
    readonly event: string;
    readonly headSha: string;
    readonly memoryAdmission?: string;
    readonly patchFingerprint?: string;
    readonly plan: string;
    readonly repositoryCreatedAt: number;
    readonly repositoryDatabaseId: number;
    readonly repositoryId: string;
    readonly reviewFiles: readonly {
      readonly path: string;
      readonly status: string;
    }[];
  },
): SessionAuthContext {
  const attributes = { ...auth.attributes };
  delete attributes[reviewContextAttributes.memoryAdmission];
  return {
    ...auth,
    attributes: {
      ...attributes,
      [routingAttribute]: values.configSource,
      [trustedVoiceGuideAttribute]: values.voiceGuideContent ?? "",
      [reviewContextAttributes.baseSha]: values.baseSha,
      [reviewContextAttributes.reviewPolicyDigest]: reviewPolicyDigest(values.configSource, values.baseSha),
      [reviewContextAttributes.event]: values.event,
      [reviewContextAttributes.headSha]: values.headSha,
      ...(values.memoryAdmission ? { [reviewContextAttributes.memoryAdmission]: values.memoryAdmission } : {}),
      [reviewContextAttributes.plan]: values.plan,
      [reviewContextAttributes.repositoryCreatedAt]: String(
        values.repositoryCreatedAt,
      ),
      [reviewContextAttributes.repositoryDatabaseId]: String(
        values.repositoryDatabaseId,
      ),
      [reviewContextAttributes.repositoryId]: values.repositoryId,
      [reviewContextAttributes.reviewFiles]: JSON.stringify(values.reviewFiles),
      ...(values.patchFingerprint
        ? {
            [reviewContextAttributes.patchFingerprint]:
              values.patchFingerprint,
          }
        : {}),
    },
  };
}

export function trustedGitHubContext(
  auth: SessionAuthContext | null | undefined,
): TrustedGitHubContext {
  if (!auth) {
    throw new Error("GitHub review tools require authenticated channel context");
  }
  const repository = auth.attributes.repository;
  if (typeof repository !== "string") {
    throw new Error("GitHub review context is missing repository identity");
  }
  const [owner, repo] = repository.split("/");
  return trustedGitHubContextSchema.parse({
    installationId: auth.attributes.installation_id,
    owner,
    repo,
    pullRequest: auth.attributes.pull_request_number,
    repository,
    repositoryCreatedAt:
      auth.attributes[reviewContextAttributes.repositoryCreatedAt],
    repositoryDatabaseId:
      auth.attributes[reviewContextAttributes.repositoryDatabaseId],
    repositoryId: auth.attributes[reviewContextAttributes.repositoryId],
    baseSha: auth.attributes[reviewContextAttributes.baseSha],
    reviewPolicyDigest: auth.attributes[reviewContextAttributes.reviewPolicyDigest],
    headSha: auth.attributes[reviewContextAttributes.headSha],
    memoryAdmission: auth.attributes[reviewContextAttributes.memoryAdmission],
    patchFingerprint:
      auth.attributes[reviewContextAttributes.patchFingerprint],
  });
}
