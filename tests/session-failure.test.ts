import { expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { axisCheckName, checkName } from "../src/github/publication";
import { reviewAxes } from "../src/review/axes";
import {
  concludeFailedSession,
  failedSessionReason,
  type FailedSessionEvent,
} from "../src/github/session-failure";

// Recorded from the production session that failed on 25 Nov 2026 (wrun_41M8…):
// the turn step exhausted its retries, so Eve emitted only `session.failed`.
const recordedFailure: FailedSessionEvent = {
  code: "FatalError",
  details: {
    errorId: "a24f285c-d3d0-40e6-8c10-f9ea00484130",
    name: "FatalError",
  },
  message:
    'Step "step//eve@0.52.5//turnStep" failed after 3 retries: Sandbox template "eve-sbx-tpl-vercel-af283af97566a823-80d8d1b1cfde9167a997" is not provisioned',
  sessionId: "wrun_41M89CSZX40GS9RY1ZW693RGPT",
};

interface CheckRun {
  readonly id: number;
  readonly name: string;
  status: string;
  conclusion: string | null;
  output?: { readonly title: string; readonly summary: string };
}

function fakeGitHub(runs: CheckRun[], options: { readonly rejectUpdate?: number } = {}) {
  const updates: { id: number; body: Record<string, unknown> }[] = [];
  const octokit = new Octokit({
    request: {
      fetch: async (resource: Request | string | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        const method = init?.method ?? "GET";
        if (method === "GET" && url.pathname === "/repos/acme/widget/commits/head/check-runs") {
          const name = url.searchParams.get("check_name");
          const matching = runs.filter((run) => run.name === name);
          return Response.json({ total_count: matching.length, check_runs: matching });
        }
        if (method === "GET" && url.pathname === "/repos/acme/widget/pulls/7") {
          return Response.json({ number: 7, head: { sha: "head" }, base: { sha: "base" } });
        }
        const update = url.pathname.match(/^\/repos\/acme\/widget\/check-runs\/(\d+)$/);
        if (method === "PATCH" && update) {
          const id = Number(update[1]);
          if (id === options.rejectUpdate) {
            return Response.json({ message: "Validation Failed" }, { status: 422 });
          }
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          updates.push({ id, body });
          const run = runs.find((candidate) => candidate.id === id);
          if (run) {
            run.status = String(body.status);
            run.conclusion = (body.conclusion as string | undefined) ?? null;
          }
          return Response.json({ id, html_url: `https://github.com/acme/widget/runs/${id}` });
        }
        throw new Error(`Unexpected GitHub request ${method} ${url.pathname}`);
      },
    },
  });
  return { octokit, updates };
}

const target = {
  headSha: "head",
  installationId: 1,
  owner: "acme",
  pullRequestNumber: 7,
  repo: "widget",
};

function runningReviewChecks(): CheckRun[] {
  return [
    { id: 1, name: checkName, status: "in_progress", conclusion: null },
    ...reviewAxes.map((axis, index) => ({
      id: 10 + index,
      name: axisCheckName(axis),
      status: "in_progress",
      conclusion: null,
    })),
  ];
}

test("a session that fails after its step retries concludes every check it left running", async () => {
  const runs = runningReviewChecks();
  const { octokit, updates } = fakeGitHub(runs);
  const comments: string[] = [];

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async (body) => { comments.push(body); },
    target,
  });

  expect(runs.map((run) => [run.name, run.status, run.conclusion])).toEqual(
    runs.map((run) => [run.name, "completed", "action_required"]),
  );
  expect(updates).toHaveLength(1 + reviewAxes.length);
  const aggregate = updates.find((update) => update.id === 1)?.body as {
    output: { title: string; summary: string };
  };
  expect(aggregate.output.title).toBe("Slop Sheriff: review incomplete");
  expect(aggregate.output.summary).toContain("REVIEW INCOMPLETE");
  expect(aggregate.output.summary).toContain("Error id: a24f285c-d3d0-40e6-8c10-f9ea00484130");
  expect(aggregate.output.summary).toContain("FatalError");
  expect(comments).toEqual([failedSessionReason(recordedFailure)]);
});

test("a comment-triggered review that dies before checkout concludes the pull request head's checks", async () => {
  // Eve seeds an issue_comment session's state with no head; only a
  // successful sandbox checkout fills it in.
  const runs = runningReviewChecks();
  const { octokit } = fakeGitHub(runs);

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target: { ...target, headSha: null },
  });

  expect(runs.every((run) => run.status === "completed" && run.conclusion === "action_required"))
    .toBe(true);
});

test("one rejected check update does not leave the other checks running", async () => {
  const runs = runningReviewChecks();
  const { octokit } = fakeGitHub(runs, { rejectUpdate: 10 });
  const comments: string[] = [];

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async (body) => { comments.push(body); },
    target,
  });

  expect(runs.filter((run) => run.status !== "completed").map((run) => run.id)).toEqual([10]);
  expect(runs[0]).toMatchObject({ status: "completed", conclusion: "action_required" });
  expect(comments).toHaveLength(1);
});

test("a failed session never overwrites checks that already completed", async () => {
  const runs: CheckRun[] = [
    { id: 1, name: checkName, status: "completed", conclusion: "success" },
    { id: 2, name: axisCheckName("deduplication"), status: "completed", conclusion: "success" },
    { id: 3, name: axisCheckName("engineering-quality"), status: "in_progress", conclusion: null },
  ];
  const { octokit, updates } = fakeGitHub(runs);

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target,
  });

  expect(updates.map((update) => update.id)).toEqual([3]);
  expect(runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
  expect(runs[1]).toMatchObject({ status: "completed", conclusion: "success" });
});

test("the failure comment is still posted when the checks cannot be reached", async () => {
  const comments: string[] = [];
  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => { throw new Error("Connect token rejected"); },
    postComment: async (body) => { comments.push(body); },
    target,
  });
  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => { throw new Error("unreachable"); },
    postComment: async (body) => { comments.push(body); },
    target: { ...target, headSha: null, pullRequestNumber: null },
  });
  expect(comments).toHaveLength(2);
});

test("the recorded reason shows no more of the error than Eve's own comment did", () => {
  const reason = failedSessionReason(recordedFailure);
  const shown = reason.match(/\(FatalError: (.*)\)\./)?.[1] ?? "";
  expect(shown.length).toBeLessThanOrEqual(160);
  expect(reason).toContain("`@slop-sheriff full review`");
  expect(failedSessionReason({ code: "WORKFLOW_FAILED", message: "", sessionId: "s" }))
    .toContain("(WORKFLOW_FAILED).");
});
