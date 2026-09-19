import { outsideReviewWork } from "../lib/review-capabilities";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import { markInitialReviewRunning } from "../../src/github/publication";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";

export const verifyReviewHeadOutputSchema = z.strictObject({ valid: z.boolean(),
  expected: z.strictObject({ base: z.string(), head: z.string() }),
  current: z.strictObject({ base: z.string(), head: z.string(), draft: z.boolean(), state: z.string() }),
});

export const reviewTool = defineTool({
  description:
    "Revalidate that the pull request is still open, reviewable, and at the trusted base/head before inspecting or publishing it. Call this after the initial debounce and immediately before every review.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (ctx.session.parent) {
      throw new Error(
        "Only the review coordinator can verify the pull request head",
      );
    }
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    const adapter = githubAdapter(trusted.installationId);
    const response = await adapter.octokit.rest.pulls.get({
      owner: trusted.owner,
      repo: trusted.repo,
      pull_number: trusted.pullRequest,
    });
    const current = response.data;
    const valid =
      current.state === "open" &&
      !current.draft &&
      current.head.sha === trusted.headSha &&
      current.base.sha === trusted.baseSha;
    if (valid) {
      const rawPlan =
        ctx.session.auth.current?.attributes[reviewContextAttributes.plan];
      if (typeof rawPlan === "string") {
        const plan = z.object({ kind: z.string(), reason: z.string().optional() })
          .parse(JSON.parse(rawPlan));
        if (plan.kind === "full" && plan.reason === "initial") {
          await markInitialReviewRunning(adapter.octokit, trusted);
        }
      }
    }
    return {
      valid,
      expected: { base: trusted.baseSha, head: trusted.headSha },
      current: {
        base: current.base.sha,
        draft: current.draft ?? false,
        head: current.head.sha,
        state: current.state,
      },
    };
  },
});

export default outsideReviewWork(reviewTool);
