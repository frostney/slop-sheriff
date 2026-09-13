import { enqueueReviewMemory, normalizedReviewMemory } from "../../src/memory/client";
import { reportAssemblyIdentitySchema } from "../../src/review/report-assembly";
import { lifecycleRequest } from "../../src/lifecycle/client";
import { z } from "zod";
import type { LifecycleJob } from "../../src/lifecycle/contracts";
import { trustedGitHubContextSchema } from "../../src/github/trusted-context";
import { reviewReportSchema } from "../../src/review/findings";
import { githubAdapter } from "../../src/github/chat-adapter";
import { publishReview, publishFailClosedCheck, stageReviewPublication } from "../../src/github/publication";
import { parseReviewConfig } from "../../src/config/review-config";

export async function deliverLifecyclePublication(job: LifecycleJob): Promise<void> {
  if (!job.publication) throw new Error("Durable publication payload missing");
  const pointer: unknown = JSON.parse(job.publication);
  const raw: unknown = z.object({ storageId: z.string() }).safeParse(pointer).success ? await lifecycleRequest("publication", { attemptId: job.attemptId }) : pointer;
  const publicationContext = z.object({ context: trustedGitHubContextSchema }).parse(raw).context;
  if (publicationContext.repositoryId !== job.repositoryId || publicationContext.deliveryId !== job.attemptId) throw new Error("Publication identity does not match admitted attempt");
  const repository = await githubAdapter(publicationContext.installationId).octokit.rest.repos.get({ owner: publicationContext.owner, repo: publicationContext.repo });
  if (repository.data.node_id !== job.repositoryId) throw new Error("Publication repository identity changed");
  if (job.publicationKind === "failure") {
    const payload = z.object({ context: trustedGitHubContextSchema, message: z.string() }).parse(raw);
    await publishFailClosedCheck({ ...payload, durableDelivery: true, octokit: githubAdapter(payload.context.installationId).octokit });
    return;
  }
  const payload = z.object({ context: trustedGitHubContextSchema, report: reviewReportSchema, identity: reportAssemblyIdentitySchema.optional(), configSource: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() }).parse(raw);
  // Stored config is application parsed from the trusted base when the report was assembled.
  const config = payload.config as ReturnType<typeof parseReviewConfig> | undefined;
  const octokit = githubAdapter(payload.context.installationId).octokit;
  if (payload.identity) await stageReviewPublication({ context: payload.context, report: payload.report, identity: payload.identity, ...(config ? { config } : {}), durableDelivery: true, octokit });
  await publishReview({ durableDelivery: true, context: payload.context, report: payload.report, ...(config ? { config } : {}), octokit });
  if (config && payload.identity) await enqueueReviewMemory(normalizedReviewMemory({ config, context: payload.context, report: payload.report, reviewKind: payload.identity.planKind }));
}
