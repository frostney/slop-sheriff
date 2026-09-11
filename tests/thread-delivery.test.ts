import { expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { findingBody, publishReview, stageReviewPublication } from "../src/github/publication";
import { decodeReviewState, encodeReviewState, type ReviewState } from "../src/github/review-state";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
import type { ReviewFinding, ReviewReport } from "../src/review/findings";

const bot = { id: 123, login: "known-good-review[bot]", type: "Bot" };
const context: TrustedGitHubContext = {
  installationId: 1, owner: "acme", repo: "widget", repository: "acme/widget",
  repositoryId: "R_widget", repositoryCreatedAt: 0, pullRequest: 7,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64),
};
function finding(id = "CR-1"): ReviewFinding {
  return {
    id, category: "QUALITY", severity: "IMPORTANT", status: "open", title: `${id}: request loses its timeout`,
    location: { path: "src/request.ts", line: 11, symbol: null }, evidence: ["request() omits the timeout argument."],
    impact: "Requests can hang indefinitely.", remedy: "Forward the timeout to the transport.", staticOnly: false, churn: null,
  };
}
function report(findings: ReviewFinding[], head = context.headSha): ReviewReport {
  return {
    schemaVersion: 2, kind: "code-review", generatedAt: "2026-09-11T00:00:00.000Z", verdict: "APPROVE",
    scope: { claim: "Forward request options", base: context.baseSha, head, dirtyState: "clean" },
    coverage: { activeAxes: ["engineering-quality"], skippedAxes: [], staticOnly: [], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [], findings,
    verifiedClaims: [], limitations: [],
  };
}
function staged(prior: ReviewReport, next: ReviewReport, kind: "delta" | "full" = "delta"): ReviewState {
  return {
    schemaVersion: 2, app: "known-good-review", pullRequest: 7, initialFullStatus: "completed",
    baseline: { head: prior.scope.head, patchFingerprint: "d".repeat(64), findingsArtifactUrl: "https://github.com/acme/widget/runs/1", files: {}, report: prior },
    pendingPublication: {
      identity: {
        baseSha: context.baseSha, headSha: context.headSha, patchFingerprint: context.patchFingerprint!,
        repositoryId: context.repositoryId, pullRequest: 7, executionRevision: "review-report-v2", planKind: kind,
        baselineHead: kind === "delta" ? prior.scope.head : null, reviewPaths: ["src/request.ts"],
        activeAxes: ["engineering-quality"], selectedFindingIds: kind === "delta" ? prior.findings.map((item) => item.id) : [],
      }, report: next, stagedAt: next.generatedAt,
    }, updatedAt: next.generatedAt,
  };
}
interface Comment {
  id: number; body: string; user: typeof bot; path: string; line: number; side: string;
  subject_type: string; commit_id: string; in_reply_to_id: number | null;
}
function harness(state: ReviewState, roots: ReviewFinding[]) {
  let stateBody = encodeReviewState(state);
  const comments: Comment[] = roots.map((item, index) => ({
    id: 201 + index, body: findingBody(item), user: bot, path: item.location.path,
    line: item.location.line, side: "RIGHT", commit_id: state.baseline!.head, subject_type: "line", in_reply_to_id: null,
  }));
  const resolved = new Set<string>();
  const replies: Array<{ comment_id: number; body: string }> = [];
  const attempts: string[] = [];
  const successes: unknown[] = [];
  const reviewEvents: string[] = [];
  const faults = { resolve: new Set<string>(), reply: new Set<number>(), head: context.headSha, changeHeadAfterReply: false, unconfirmedResolution: false };
  const octokit = new Octokit({ request: { fetch: async (resource: Request | string | URL, init?: RequestInit) => {
    const path = new URL(String(resource)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "GET" && path.endsWith("/pulls/7")) return Response.json({ state: "open", draft: false, base: { sha: context.baseSha }, head: { sha: faults.head } });
    if (method === "GET" && path.endsWith("/files")) return Response.json([{ filename: "src/request.ts", sha: "blob", status: "modified", patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context" }]);
    if (method === "GET" && path.endsWith("/pulls/7/comments")) return Response.json(comments);
    if (method === "GET" && path.endsWith("/issues/7/comments")) return Response.json([{ id: 401, body: stateBody, user: bot }]);
    if (method === "PATCH" && path.endsWith("/issues/comments/401")) { stateBody = body.body; return Response.json({ id: 401, body: stateBody }); }
    if (method === "GET" && path.endsWith("/check-runs")) return Response.json({ check_runs: [], total_count: 0 });
    if (method === "POST" && path.endsWith("/check-runs")) { successes.push(body); return Response.json({ id: 300, html_url: "https://github.com/acme/widget/runs/300" }); }
    if (method === "GET" && path.endsWith("/reviews")) return Response.json([]);
    if (method === "POST" && path.endsWith("/reviews")) return Response.json({ id: 101, node_id: "PRR_101" });
    if (method === "POST" && path.endsWith("/events")) { reviewEvents.push(body.event); return Response.json({ id: 101, state: "COMMENTED" }); }
    const reply = path.match(/comments\/(\d+)\/replies$/);
    if (method === "POST" && reply) {
      const rootId = Number(reply[1]);
      if (faults.reply.has(rootId)) return Response.json({ message: "Reply unavailable" }, { status: 403 });
      replies.push({ comment_id: rootId, body: body.body });
      const comment = { ...comments.find((item) => item.id === rootId)!, id: 500 + replies.length, body: body.body, in_reply_to_id: rootId, user: bot };
      comments.push(comment);
      if (faults.changeHeadAfterReply) faults.head = "e".repeat(40);
      return Response.json(comment);
    }
    const update = path.match(/pulls\/comments\/(\d+)$/);
    if (method === "PATCH" && update) {
      const comment = comments.find((item) => item.id === Number(update[1]))!;
      comment.body = body.body;
      return Response.json(comment);
    }
    if (path === "/graphql") {
      if (body.query.includes("KnownGoodReviewThreads")) return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: comments.filter((item) => item.in_reply_to_id === null).map((item) => ({ id: `T_${item.id}`, isResolved: resolved.has(`T_${item.id}`), comments: { nodes: [{ databaseId: item.id, body: item.body }] } })),
        pageInfo: { endCursor: null, hasNextPage: false },
      } } } } });
      if (body.query.includes("KnownGoodReviewResolveThread")) {
        const id = body.variables.threadId;
        attempts.push(id);
        if (faults.resolve.has(id)) return Response.json({ data: { resolveReviewThread: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
        if (!faults.unconfirmedResolution) resolved.add(id);
        return Response.json({ data: { resolveReviewThread: { thread: { id, isResolved: !faults.unconfirmedResolution } } } });
      }
      if (body.query.includes("KnownGoodReviewAddReviewThread")) {
        const input = body.variables.input;
        comments.push({ id: 300 + comments.length, body: input.body, user: bot, path: input.path, line: input.line, side: "RIGHT", commit_id: context.headSha, subject_type: input.subjectType.toLowerCase(), in_reply_to_id: null });
        return Response.json({ data: { addPullRequestReviewThread: { thread: { id: "NEW" } } } });
      }
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  } } });
  return { octokit, comments, resolved, replies, attempts, successes, reviewEvents, faults, state: () => decodeReviewState(stateBody)! };
}
function fixed(original: ReviewFinding): ReviewFinding {
  return { ...original, status: "fixed", title: "Timeout is now forwarded", impact: "Requests terminate within their configured deadline.", remedy: "No further change needed.", evidence: ["request.test.ts timeout regression passes: the transport receives the configured deadline."] };
}

test("delta revalidation preserves original thread identity despite rewritten prose", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.resolved.has("T_201")).toBeTrue();
  expect(mock.replies[0]?.body).toContain("Verified fixed");
  expect(mock.replies[0]?.body).toContain(`/commit/${context.headSha}`);
  expect(mock.replies[0]?.body).toContain("timeout regression passes");
});

test("fixed-thread replies honor the personality switch", async () => {
  for (const personality of [true, false]) {
    const prior = report([finding()], "d".repeat(40));
    const next = report(prior.findings.map((item) => ({ ...fixed(item), evidence: ["The regression probe passes. ".repeat(30)] })));
    const mock = harness(staged(prior, next), prior.findings);
    await publishReview({ context, octokit: mock.octokit, report: next, config: { blocking: false, profile: "balanced", personality } });
    expect(mock.replies[0]?.body.includes("Trail’s clear now, partner.")).toBe(personality);
    expect(mock.replies[0]?.body).toContain("Verified fixed");
    expect(mock.replies[0]!.body.split("\n").slice(1).join("\n").length).toBeLessThanOrEqual(300);
  }
});

test("thread delivery continues after one failure and retries without duplicate replies", async () => {
  const prior = report([finding(), finding("CR-2")], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  mock.faults.resolve.add("T_201");
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("T_201 (CR-1): GraphqlResponseError [FORBIDDEN]");
  expect(mock.attempts).toEqual(["T_201", "T_202"]);
  expect(mock.state().baseline?.head).toBe(prior.scope.head);
  expect(mock.state().pendingPublication?.report).toEqual(next);
  expect(mock.successes).toHaveLength(0);
  mock.faults.resolve.clear();
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.replies).toHaveLength(2);
  expect(mock.attempts).toEqual(["T_201", "T_202", "T_201"]);
  expect(mock.state().pendingPublication).toBeUndefined();
});

test("a hidden profile finding remains unresolved without a fixed reply", async () => {
  const prior = report([{ ...finding(), severity: "NITPICK" }], "d".repeat(40));
  const next = report(prior.findings);
  const mock = harness(staged(prior, next), prior.findings);
  await publishReview({ context, octokit: mock.octokit, report: next, config: { blocking: false, profile: "balanced" } });
  expect(mock.replies).toHaveLength(0);
  expect(mock.attempts).toHaveLength(0);
});

test("full review CR number reuse never resolves an unrelated old finding", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report([{ ...fixed(finding()), title: "A completely different defect" }]);
  const mock = harness(staged(prior, next, "full"), prior.findings);
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.attempts).toHaveLength(0);
  expect(mock.replies).toHaveLength(0);
});

test("repeated deltas retain the first thread hash across open prose rewrites", async () => {
  const original = finding();
  const prior = report([original], "d".repeat(40));
  const changed = { ...original, title: "The timeout is still omitted after refactoring", evidence: ["Refactored request() still omits timeout."] };
  const next = report([changed]);
  const mock = harness(staged(prior, next), prior.findings);
  const originalMarker = mock.comments[0]!.body.split("\n")[0];
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.comments[0]!.body.split("\n")[0]).toBe(originalMarker);
  expect(mock.comments[0]!.body).toContain(changed.title);
  const following = report([fixed(changed)]);
  const nextStage = staged(next, following);
  nextStage.baseline!.findingThreadIdentities = mock.state().baseline?.findingThreadIdentities;
  const resumed = harness(nextStage, [original]);
  await publishReview({ context, octokit: resumed.octokit, report: following });
  expect(resumed.resolved.has("T_201")).toBeTrue();
});

test("trusted delta state links legacy CR markers without changing unrelated legacy threads", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), [...prior.findings, finding("CR-99")]);
  mock.comments[0]!.body = "<!-- known-good-review:finding:CR-1 -->\nOriginal legacy finding";
  mock.comments[1]!.body = "<!-- known-good-review:finding:CR-99 -->\nUntracked legacy finding";
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.attempts).toEqual(["T_201"]);
});

test("a runtime finding cannot be fixed by static-only revalidation", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report([{ ...fixed(finding()), staticOnly: true }]);
  const mock = harness(staged(prior, next), prior.findings);
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("requires runtime revalidation");
  expect(mock.replies).toHaveLength(0);
  expect(mock.successes).toHaveLength(0);
  expect(mock.state().baseline?.head).toBe(prior.scope.head);
});

test("a source-verified original finding can be fixed with source evidence", async () => {
  const prior = report([{ ...finding(), staticOnly: true }], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.attempts).toEqual(["T_201"]);
});

test("human roots are untouched and a human copied resolution marker cannot suppress a bot reply", async () => {
  const prior = report([finding(), finding("CR-2")], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  const human = { id: 987, login: "maintainer", type: "User" };
  mock.comments[1]!.user = human;
  mock.comments.push({ ...mock.comments[0]!, id: 888, user: human, in_reply_to_id: 201,
    body: `<!-- known-good-review:resolution:CR-1:${context.headSha}:fixed -->\nCopied marker` });
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.replies.map((reply) => reply.comment_id)).toEqual([201]);
  expect(mock.attempts).toEqual(["T_201"]);
});

test("each duplicate root gets its own reply and resolution checkpoint", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), [finding(), finding()]);
  mock.faults.resolve.add("T_201");
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("thread delivery");
  expect(mock.replies.map((reply) => reply.comment_id)).toEqual([201, 202]);
  mock.faults.resolve.clear();
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.replies).toHaveLength(2);
  expect(mock.attempts).toEqual(["T_201", "T_202", "T_201"]);
});

test("a failed reply leaves its thread open while unrelated delivery progresses", async () => {
  const prior = report([finding(), finding("CR-2")], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  mock.faults.reply.add(201);
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("thread delivery");
  expect(mock.attempts).toEqual(["T_202"]);
  mock.faults.reply.clear();
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.replies.map((reply) => reply.comment_id)).toEqual([202, 201]);
});

test("a head change after the reply prevents resolution and completion", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  mock.faults.changeHeadAfterReply = true;
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("thread delivery");
  expect(mock.replies).toHaveLength(1);
  expect(mock.attempts).toHaveLength(0);
  expect(mock.successes).toHaveLength(0);
});

test("a mutation response that does not confirm resolution stays retryable", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  mock.faults.unconfirmedResolution = true;
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("thread delivery");
  expect(mock.state().pendingPublication).toBeDefined();
  mock.faults.unconfirmedResolution = false;
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.replies).toHaveLength(1);
});

test("moved-thread recovery retains the replacement and retries the original thread only", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report([{ ...finding(), location: { path: "src/request.ts", line: 12, symbol: null } }]);
  const mock = harness(staged(prior, next), prior.findings);
  mock.faults.resolve.add("T_201");
  await expect(publishReview({ context, octokit: mock.octokit, report: next })).rejects.toThrow("thread delivery");
  expect(mock.comments.filter((comment) => comment.in_reply_to_id === null)).toHaveLength(2);
  expect(mock.replies[0]?.body).toContain("moved to a new inline location");
  mock.faults.resolve.clear();
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.comments.filter((comment) => comment.in_reply_to_id === null)).toHaveLength(2);
  expect(mock.replies).toHaveLength(1);
  expect(mock.attempts).toEqual(["T_201", "T_201"]);
});

test("a recurring finding receives a new open thread instead of updating its resolved predecessor", async () => {
  const prior = report([fixed(finding())], "d".repeat(40));
  const next = report([{ ...fixed(finding()), status: "open" }]);
  const mock = harness(staged(prior, next), prior.findings);
  mock.resolved.add("T_201");
  const oldBody = mock.comments[0]!.body;
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.comments[0]!.body).toBe(oldBody);
  expect(mock.comments.filter((comment) => comment.in_reply_to_id === null)).toHaveLength(2);
  expect(mock.attempts).toHaveLength(0);
});

test("an ancient legacy marker cannot borrow a CR number from a later baseline", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  mock.comments[0]!.body = "<!-- known-good-review:finding:CR-1 -->\nAn older unrelated finding";
  mock.comments[0]!.commit_id = "e".repeat(40);
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.replies).toHaveLength(0);
  expect(mock.attempts).toHaveLength(0);
});

test("blocking approval waits for all required thread delivery", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report(prior.findings.map(fixed));
  const mock = harness(staged(prior, next), prior.findings);
  mock.faults.resolve.add("T_201");
  const config = { blocking: true, profile: "balanced" as const };
  await expect(publishReview({ context, octokit: mock.octokit, report: next, config })).rejects.toThrow("thread delivery");
  expect(mock.reviewEvents).toHaveLength(0);
  mock.faults.resolve.clear();
  await publishReview({ context, octokit: mock.octokit, report: next, config });
  expect(mock.reviewEvents).toEqual(["APPROVE"]);
});

test("direct staging rejects verbose active findings before any GitHub request", async () => {
  const prior = report([finding()], "d".repeat(40));
  const next = report([{ ...finding(), evidence: ["concrete evidence ".repeat(100)] }]);
  const state = staged(prior, next);
  let requests = 0;
  const octokit = new Octokit({ request: { fetch: async () => { requests += 1; return Response.json([]); } } });
  await expect(stageReviewPublication({ context, octokit, report: next, identity: state.pendingPublication!.identity }))
    .rejects.toThrow("100-word inline limit");
  expect(requests).toBe(0);
});

test("runtime requirements survive a deferred source-only delta before a later attempted fix", async () => {
  const original = finding();
  const prior = report([original], "d".repeat(40));
  const deferred = { ...original, status: "deferred" as const, staticOnly: true, evidence: ["Runtime unavailable; the timeout regression could not run."] };
  const first = report([deferred]);
  const mock = harness(staged(prior, first), prior.findings);
  await publishReview({ context, octokit: mock.octokit, report: first });
  const nextContext = { ...context, headSha: "e".repeat(40) };
  const second = report([{ ...fixed(deferred), staticOnly: true }], nextContext.headSha);
  const identity = { ...staged(first, second).pendingPublication!.identity, headSha: nextContext.headSha };
  mock.faults.head = nextContext.headSha;
  await expect(stageReviewPublication({ context: nextContext, octokit: mock.octokit, report: second, identity }))
    .rejects.toThrow("requires runtime revalidation");
  expect(mock.state().baseline?.findingRuntimeRequirements).toEqual({ "CR-1": true });
  expect(mock.state().pendingPublication).toBeUndefined();
  // An already-staged report from an older deployment is rejected on retry as well.
  const resumedState = staged(first, second);
  resumedState.baseline = mock.state().baseline;
  resumedState.pendingPublication!.identity = identity;
  const resumed = harness(resumedState, [original]);
  resumed.faults.head = nextContext.headSha;
  await expect(publishReview({ context: nextContext, octokit: resumed.octokit, report: second }))
    .rejects.toThrow("requires runtime revalidation");
  expect(resumed.replies).toHaveLength(0);
  expect(resumed.attempts).toHaveLength(0);
  expect(resumed.state().baseline?.head).toBe(first.scope.head);
  const verified = report([{ ...fixed(deferred), staticOnly: false }], nextContext.headSha);
  await stageReviewPublication({ context: nextContext, octokit: mock.octokit, report: verified, identity });
  await publishReview({ context: nextContext, octokit: mock.octokit, report: verified });
  expect(mock.attempts).toEqual(["T_201"]);
  expect(mock.state().baseline?.findingRuntimeRequirements).toEqual({ "CR-1": true });
});

test("a full review resets runtime requirements when it reuses CR numbers", async () => {
  const prior = report([{ ...finding(), status: "deferred", staticOnly: true }], "d".repeat(40));
  const next = report([{ ...fixed(finding()), title: "Unrelated source-only defect", staticOnly: true }]);
  const state = staged(prior, next, "full");
  state.baseline!.findingRuntimeRequirements = { "CR-1": true };
  const mock = harness(state, prior.findings);
  await publishReview({ context, octokit: mock.octokit, report: next });
  expect(mock.state().baseline?.findingRuntimeRequirements).toEqual({ "CR-1": false });
  expect(mock.attempts).toHaveLength(0);
});
