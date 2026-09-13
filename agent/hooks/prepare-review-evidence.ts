import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { defineHook } from "eve/hooks";
import { reviewToolResult } from "../lib/review-tool-results";
import { z } from "zod";
import { parseReviewConfig } from "../../src/config/review-config";
import { githubAdapter } from "../../src/github/chat-adapter";
import { collectExactHeadGitHubEvidence } from "../../src/github/exact-head-evidence";
import { prepareReviewEvidence } from "../../src/review/prepare-review-evidence";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import { verifyReviewHeadOutputSchema } from "../tools/verify_review_head";
import { retrieveReviewMemory } from "../../src/memory/client";
import { routingAttribute } from "../../src/models/routing";
import { reviewAxisSchema } from "../../src/review/axes";

const reviewPlanSchema = z.object({ kind: z.enum(["full", "delta"]), axisDecisions: z.array(z.object({
  axis: reviewAxisSchema, selected: z.boolean(), reason: z.string(), paths: z.array(z.string()),
})) });

export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      const verified = reviewToolResult(event.data.result, "verify_review_head", verifyReviewHeadOutputSchema);
      if (!verified?.valid || ctx.session.parent) return;
      const trusted = trustedGitHubContext(ctx.session.auth.current);
      if (!trusted.repositoryDatabaseId) {
        throw new Error(
          "Trusted review context is missing the repository database id",
        );
      }
      const repositoryDatabaseId = trusted.repositoryDatabaseId;
      const rawFiles =
        ctx.session.auth.current?.attributes[
          reviewContextAttributes.reviewFiles
        ];
      if (typeof rawFiles !== "string") {
        throw new Error(
          "Trusted review context is missing the exact file scope",
        );
      }
      const rawPlan =
        ctx.session.auth.current?.attributes[reviewContextAttributes.plan];
      if (typeof rawPlan !== "string") {
        throw new Error("Trusted review context is missing the review plan");
      }
      const plan = reviewPlanSchema.parse(JSON.parse(rawPlan));
      const configSource = ctx.session.auth.current?.attributes[routingAttribute];
      const config = parseReviewConfig(
        typeof configSource === "string" ? configSource : null,
      );
      const preparationStartedAt = performance.now();
      const ledger = await prepareReviewEvidence(
        await getReviewEvidenceSandbox(ctx),
        trusted,
        JSON.parse(rawFiles),
        {
          config,
          work: { decisions: plan.axisDecisions, claim: String(ctx.session.auth.current?.attributes[reviewContextAttributes.claim] ?? "") },
          planKind: plan.kind,
          collectMemory: (query) =>
            retrieveReviewMemory({
              config,
              repositoryId: trusted.repositoryId,
              axis: "claim-and-specification",
              query,
            }),
          collectGitHubEvidence: () =>
            collectExactHeadGitHubEvidence(
              githubAdapter(trusted.installationId).octokit,
              {
                headSha: trusted.headSha,
                owner: trusted.owner,
                repo: trusted.repo,
                repositoryDatabaseId,
              },
            ),
        },
      );
      console.info(
        JSON.stringify({
          event: "known-good-review.phase.completed",
          phase: "common-preparation",
          sessionId: ctx.session.id,
          durationMs: performance.now() - preparationStartedAt,
          ledgerDigest: ledger.digest,
          commonWorkIds: ledger.commonWork.records.map((record) => record.id),
        }),
      );
    },
  },
});
