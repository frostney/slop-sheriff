import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import { publishSessionFailure } from "../../src/github/publication";
import { trustedGitHubContextSchema } from "../../src/github/trusted-context";

export async function handleReviewSessionFailure(
  event: { readonly code: string; readonly message: string },
  ctx: { readonly state: unknown },
): Promise<void> {
  const state = z.object({ slopSheriffReviewContext: trustedGitHubContextSchema }).safeParse(ctx.state);
  if (!state.success) return;
  const context = state.data.slopSheriffReviewContext;
  // Raw provider errors can contain request payloads or credentials. Publish
  // bounded application wording, never the serialized error or its stack.
  const creditFailure = /insufficient_funds|positive credit balance/i.test(event.message);
  const keyBudgetFailure = /API key budget exceeded/i.test(event.message);
  await publishSessionFailure({
    context,
    octokit: githubAdapter(context.installationId).octokit,
    message: keyBudgetFailure
      ? "Review stopped because AI Gateway rejected the request at the API key’s spending limit. Investigate review usage before retrying. Account credit and the key’s configured budget are separate. No merge clearance was issued."
      : creditFailure
      ? "Review stopped because AI Gateway rejected the request for insufficient credit. Restore Gateway credit, then request a full review. No merge clearance was issued."
      : "Review execution failed after runtime retries. Inspect the deployment logs, repair the failure, then request a full review. No merge clearance was issued.",
  });
}
