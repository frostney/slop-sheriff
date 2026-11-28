import { afterAll, expect, spyOn, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { defaultGitHubAuth, type GitHubInboundContext } from "eve/channels/github";
import { axisCheckName, checkName } from "../src/github/publication";
import { reviewAxes } from "../src/review/axes";
import {
  reviewAttemptFromAuth,
  reviewAttemptStateKey,
  withAcceptedReviewState,
} from "../src/github/session-routing";
import { reviewContextAttributes } from "../src/github/trusted-context";
import * as chatAdapter from "../src/github/chat-adapter";
import * as connectChannel from "../src/github/connect-channel";

// Exercise the production channel module: only Vercel Connect credentials and
// the installation Octokit are replaced, so the test fails if the channel stops
// registering `session.failed` or stops reading the attempt from its state.

interface Run {
  readonly id: number;
  readonly name: string;
  status: string;
  conclusion: string | null;
  output?: { readonly text?: string } | undefined;
}

const runs: Run[] = [];
const comments: string[] = [];

const octokit = new Octokit({
  request: {
    fetch: async (resource: Request | string | URL, init?: RequestInit) => {
      const url = new URL(String(resource));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/repos/acme/widget/commits/accepted/check-runs") {
        const name = url.searchParams.get("check_name");
        const matching = runs.filter((run) => run.name === name);
        return Response.json({ total_count: matching.length, check_runs: matching });
      }
      const update = url.pathname.match(/^\/repos\/acme\/widget\/check-runs\/(\d+)$/);
      if (method === "PATCH" && update) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const run = runs.find((candidate) => candidate.id === Number(update[1]));
        if (run) {
          run.status = String(body.status);
          run.conclusion = (body.conclusion as string | undefined) ?? null;
          if (body.output) run.output = body.output as Run["output"];
        }
        return Response.json({ id: Number(update[1]) });
      }
      throw new Error(`Unexpected GitHub request ${method} ${url.pathname}`);
    },
  },
});

const githubApiFetch = async (resource: Request | string | URL, init?: RequestInit) => {
  const url = new URL(String(resource));
  if ((init?.method ?? "GET") === "POST" && url.pathname === "/repos/acme/widget/issues/7/comments") {
    comments.push(String((JSON.parse(String(init?.body)) as { body: string }).body));
    return Response.json({ id: comments.length, html_url: "https://github.com/acme/widget/pull/7" }, { status: 201 });
  }
  throw new Error(`Unexpected channel request ${init?.method ?? "GET"} ${url.pathname}`);
};

// Spies, unlike module mocks, are restored after this file, so other test
// files keep the real Connect modules.
const credentials = spyOn(connectChannel, "connectedGitHubChannel").mockReturnValue({
  credentials: {
    appSlug: "slop-sheriff",
    installationToken: async () => "installation-token",
    webhookVerifier: async () => true,
  },
  api: { fetch: githubApiFetch },
} as unknown as ReturnType<typeof connectChannel.connectedGitHubChannel>);
const installation = spyOn(chatAdapter, "githubAdapter").mockReturnValue(
  { octokit } as unknown as ReturnType<typeof chatAdapter.githubAdapter>,
);
afterAll(() => {
  credentials.mockRestore();
  installation.mockRestore();
});

const { default: channel } = await import("../agent/channels/github");

type Adapter = Record<string, unknown> & {
  createAdapterContext(input: { state: unknown; ctx: unknown; session: unknown }): unknown;
};
// The adapter is runtime-only: Eve dispatches channel events through it.
const adapter = (channel as unknown as { readonly adapter: Adapter }).adapter;

function inboundContext(deliveryId: string): GitHubInboundContext {
  return {
    conversation: { issueNumber: 7, kind: "pull_request", pullRequestNumber: 7 },
    delivery: { event: "pull_request", hookId: null, id: deliveryId },
    github: { installationId: 1 },
    repository: { fullName: "acme/widget", id: 99, name: "widget", owner: "acme" },
    sender: { id: 5, login: "maintainer", type: "User" },
  } as unknown as GitHubInboundContext;
}

test("the production channel concludes the failed attempt's checks from its persisted state", async () => {
  // The dispatch records the same attempt on the check marker and, through the
  // session routing, on the new session's channel state.
  const auth = defaultGitHubAuth(inboundContext("delivery-7"));
  const attempt = reviewAttemptFromAuth(auth);
  expect(attempt).toBe("delivery-7");
  runs.push(
    {
      id: 1,
      name: checkName,
      status: "in_progress",
      conclusion: null,
      output: { text: `<!-- slop-sheriff:review-attempt:${attempt} -->` },
    },
    ...reviewAxes.map((axis, index) => ({
      id: 10 + index,
      name: axisCheckName(axis),
      status: "in_progress",
      conclusion: null,
    })),
  );
  const sent = withAcceptedReviewState({
    auth: { ...auth, attributes: { ...auth.attributes, [reviewContextAttributes.headSha]: "accepted" } },
    state: {
      baseRef: null, baseSha: null, checkoutPath: null, conversationKind: "pull_request",
      defaultBranch: null, headRef: null, headSha: null, installationId: 1, issueNumber: 7,
      owner: "acme", pullRequestNumber: 7, repo: "widget", repositoryId: 99,
      reviewCommentId: null, reviewThreadRootCommentId: null, triggeringCommentId: null,
      triggeringUserLogin: "maintainer",
    },
  });
  const state = (sent as { readonly state: Record<string, unknown> }).state;
  expect(state[reviewAttemptStateKey]).toBe("delivery-7");

  const handler = adapter["session.failed"];
  expect(typeof handler).toBe("function");
  await (handler as (data: unknown, context: unknown) => Promise<void>)(
    {
      code: "FatalError",
      details: { errorId: "a24f285c", name: "FatalError" },
      message: "Step failed after 3 retries",
      sessionId: "wrun_test",
    },
    adapter.createAdapterContext({ state, ctx: undefined, session: undefined }),
  );

  expect(runs.map((run) => [run.status, run.conclusion])).toEqual(
    runs.map(() => ["completed", "action_required"]),
  );
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("Error id: a24f285c");
});
