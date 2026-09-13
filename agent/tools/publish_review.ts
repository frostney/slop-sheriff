import { currentReviewReportState } from "../lib/review-report";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { parseReviewConfig } from "../../src/config/review-config";
import { githubAdapter } from "../../src/github/chat-adapter";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { routingAttribute } from "../../src/models/routing";
import { publishPendingReview } from "../lib/publish-review";

export const publishReviewInputSchema = z.strictObject({});

export default defineTool({
  description:
    "Publish the application-assembled report already staged for this trusted review identity. The tool accepts no model-authored report or publication target.",
  inputSchema: publishReviewInputSchema,
  async execute(_input, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can publish a review");
    }
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error(
        "Trusted review context is missing the effective patch identity",
      );
    }
    const attributes = ctx.session.auth.current?.attributes ?? {};
    const rawConfig = attributes[routingAttribute];
    const config = parseReviewConfig(
      typeof rawConfig === "string" ? rawConfig : null,
    );
    return publishPendingReview({
      config,
      context: trusted,
      staged: currentReviewReportState(ctx.session.auth.current),
      octokit: githubAdapter(trusted.installationId).octokit,
    });
  },
});
