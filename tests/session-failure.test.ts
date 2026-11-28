import { expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import {
  axisCheckName,
  checkName,
  publishInProgressCheck,
  reviewAttemptOf,
} from "../src/github/publication";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
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
  readonly headSha?: string;
  readonly name: string;
  status: string;
  conclusion: string | null;
  output?: { readonly title?: string; readonly summary?: string; readonly text?: string } | undefined;
}

function fakeGitHub(
  runs: CheckRun[],
  options: { readonly rejectUpdate?: number; rejections?: number } = {},
) {
  const updates: { id: number; body: Record<string, unknown> }[] = [];
  const octokit = new Octokit({
    request: {
      fetch: async (resource: Request | string | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        const method = init?.method ?? "GET";
        const listed = url.pathname.match(/^\/repos\/acme\/widget\/commits\/([^/]+)\/check-runs$/);
        if (method === "GET" && listed) {
          const name = url.searchParams.get("check_name");
          const matching = runs.filter((run) =>
            run.name === name && (run.headSha ?? "head") === listed[1]);
          return Response.json({ total_count: matching.length, check_runs: matching });
        }
        const update = url.pathname.match(/^\/repos\/acme\/widget\/check-runs\/(\d+)$/);
        if (method === "PATCH" && update) {
          const id = Number(update[1]);
          if (id === options.rejectUpdate && (options.rejections ?? Infinity) > 0) {
            if (options.rejections !== undefined) options.rejections -= 1;
            return Response.json({ message: "Validation Failed" }, { status: 422 });
          }
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          updates.push({ id, body });
          const run = runs.find((candidate) => candidate.id === id);
          if (run) {
            run.status = String(body.status);
            run.conclusion = (body.conclusion as string | undefined) ?? null;
            if (body.output) run.output = body.output as CheckRun["output"];
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
  repo: "widget",
  reviewAttempt: "delivery-1",
};

const attemptText = (attempt: string) => `<!-- slop-sheriff:review-attempt:${attempt} -->`;

function runningReviewChecks(
  headSha = "head",
  firstId = 1,
  attempt: string | null = "delivery-1",
): CheckRun[] {
  return [
    {
      id: firstId,
      headSha,
      name: checkName,
      status: "in_progress",
      conclusion: null,
      ...attempt === null ? {} : { output: { text: attemptText(attempt) } },
    },
    ...reviewAxes.map((axis, index) => ({
      id: firstId + 10 + index,
      headSha,
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

test("a failed review concludes its own head's checks, not a newer review's on the advanced head", async () => {
  // The pull request moved from head-a to head-b and a newer review created
  // its checks on head-b before the old session's failure event arrived.
  const old = runningReviewChecks("head-a", 100);
  const newer = runningReviewChecks("head-b", 200, "delivery-2");
  const { octokit } = fakeGitHub([...old, ...newer]);

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target: { ...target, headSha: "head-a" },
  });

  expect(old.every((run) => run.status === "completed" && run.conclusion === "action_required"))
    .toBe(true);
  expect(newer.every((run) => run.status === "in_progress")).toBe(true);
});

test("one rejected check update does not leave the other checks running", async () => {
  const runs = runningReviewChecks();
  const { octokit } = fakeGitHub(runs, { rejectUpdate: 11 });
  const comments: string[] = [];

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async (body) => { comments.push(body); },
    target,
  });

  expect(runs.filter((run) => run.status !== "completed").map((run) => run.id)).toEqual([11]);
  expect(runs[0]).toMatchObject({ status: "completed", conclusion: "action_required" });
  expect(comments).toHaveLength(1);
});

test("a replacement review on the same head keeps the runs it took over from the failed attempt", async () => {
  // The old attempt's checks are running when an authorized manual full review
  // is accepted for the same commit and takes the runs over, and only then
  // does the old session's failure event arrive.
  const runs = runningReviewChecks("head", 1, "delivery-1");
  const { octokit } = fakeGitHub(runs);
  const context: TrustedGitHubContext = {
    baseSha: "base",
    headSha: "head",
    installationId: 1,
    owner: "acme",
    pullRequest: 7,
    repo: "widget",
    repository: "acme/widget",
    repositoryCreatedAt: 0,
    repositoryId: "R_widget",
  };
  await publishInProgressCheck({
    activeAxes: reviewAxes,
    attempt: "delivery-2",
    context,
    octokit,
    review: { kind: "full", reason: "manual" },
  });
  expect(reviewAttemptOf(runs[0]?.output?.text)).toBe("delivery-2");

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target: { ...target, reviewAttempt: "delivery-1" },
  });
  expect(runs.every((run) => run.status === "in_progress")).toBe(true);

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target: { ...target, reviewAttempt: "delivery-2" },
  });
  expect(runs.every((run) => run.status === "completed" && run.conclusion === "action_required"))
    .toBe(true);
});

test("a session and checks from before attempts were recorded still conclude", async () => {
  const runs = runningReviewChecks("head", 1, null);
  const { octokit } = fakeGitHub(runs);
  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target: { ...target, reviewAttempt: null },
  });
  expect(runs.every((run) => run.status === "completed")).toBe(true);
});

test("a transiently rejected check update is retried in the same pass", async () => {
  const runs = runningReviewChecks();
  const { octokit } = fakeGitHub(runs, { rejectUpdate: 11, rejections: 1 });

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target,
  });

  expect(runs.every((run) => run.status === "completed" && run.conclusion === "action_required"))
    .toBe(true);
});

test("a second pass by the same attempt reaches an axis whose updates were all rejected", async () => {
  const runs = runningReviewChecks();
  const options: { readonly rejectUpdate: number; rejections: number } = { rejectUpdate: 11, rejections: 2 };
  const { octokit, updates } = fakeGitHub(runs, options);
  const fail = () => concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target,
  });

  await fail();
  expect(runs.filter((run) => run.status !== "completed").map((run) => run.id)).toEqual([11]);
  expect(reviewAttemptOf(runs[0]?.output?.text)).toBe("delivery-1");
  const aggregateUpdates = updates.filter((update) => update.id === 1).length;

  await fail();
  expect(runs.every((run) => run.status === "completed")).toBe(true);
  expect(updates.filter((update) => update.id === 1)).toHaveLength(aggregateUpdates);
});

test("a failed session never overwrites checks that already completed", async () => {
  const runs: CheckRun[] = [
    { id: 1, name: checkName, status: "in_progress", conclusion: null, output: { text: attemptText("delivery-1") } },
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

  expect(updates.map((update) => update.id).sort()).toEqual([1, 3]);
  expect(runs[1]).toMatchObject({ status: "completed", conclusion: "success" });
});

test("a published review is left as it is", async () => {
  const runs: CheckRun[] = [
    { id: 1, name: checkName, status: "completed", conclusion: "success", output: { text: attemptText("delivery-1") } },
    { id: 2, name: axisCheckName("deduplication"), status: "completed", conclusion: "success" },
  ];
  const { octokit, updates } = fakeGitHub(runs);

  await concludeFailedSession({
    event: recordedFailure,
    octokitFor: () => octokit,
    postComment: async () => {},
    target,
  });

  expect(updates).toEqual([]);
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
    target: { ...target, headSha: null },
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

test("every field of the reason is bounded, so the comment and summaries always fit", () => {
  const huge = "x".repeat(70_000);
  for (const event of [
    { code: huge, message: huge, sessionId: "s" },
    { code: "C", details: { errorId: huge, name: huge }, message: huge, sessionId: "s" },
  ]) {
    expect(failedSessionReason(event).length).toBeLessThan(600);
  }
});

test("the message excerpt never splits a character at its bound", () => {
  const reason = failedSessionReason({
    code: "FatalError",
    message: `${"a".repeat(158)}👩‍👩‍👧 then more`,
    sessionId: "s",
  });
  expect(reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(reason).toContain(`${"a".repeat(158)}…`);
});
