import { outsideReviewWork } from "../lib/review-capabilities";
import { defineTool } from "eve/tools";
import { z } from "zod";

export const reviewTool = defineTool({
  description:
    "Remove the closed pull request's inspected workspace and stop its isolated sandbox. Use only for the cleanup operation selected by trusted GitHub lifecycle context.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (ctx.session.parent) {
      throw new Error(
        "Only the review coordinator can clean up a review sandbox",
      );
    }
    const plan = ctx.session.auth.current?.attributes.known_good_review_plan;
    if (plan !== "cleanup") {
      throw new Error(
        "Sandbox cleanup is allowed only for a trusted cleanup event",
      );
    }
    const sandbox = await ctx.getSandbox();
    try {
      const result = await sandbox.run({
        command: "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && rm -rf -- /tmp/known-good-review",
      });
      if (result.exitCode !== 0) {
        throw new Error("Review sandbox cleanup failed");
      }
    } finally {
      await sandbox.stop();
    }
    return { cleaned: true, sandboxId: sandbox.id };
  },
});

export default outsideReviewWork(reviewTool);
