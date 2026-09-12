import { describe, expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  activeReviewExternalId,
  findingBody,
  markInitialReviewRunning,
  parseActiveReviewExternalId,
  publishFailClosedCheck,
  publishInProgressCheck,
  publishReview,
  readLatestReviewState,
  stageReviewPublication,
  writeReviewState,
  writeReviewFailureState,
} from "../src/github/publication";
import { decodeReviewState, encodeReviewState, maxReviewStateBytes } from "../src/github/review-state";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
import type { ReviewReport } from "../src/review/findings";
import { beginReportAssembly, reportAssemblyFailure, ReviewReportValidationError } from "../src/review/report-assembly";
import {
  advanceReviewRecovery,
  beginReviewRecovery,
  buildReviewFailureEnvelope,
} from "../src/review/recovery";

const botUser = { id: 123, login: "known-good-review[bot]", type: "Bot" };

test.each([false, true])("failed review check never claims completion (existing check: %s)", async (existing) => {
  const writes: unknown[] = [];
  const octokit = new Octokit({ request: { fetch: async (_resource: Request | string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      return json({ check_runs: existing ? [{ id: 123, name: "known-good-review", status: "in_progress" }] : [] });
    }
    writes.push(JSON.parse(String(init?.body)));
    return json({ id: 123, html_url: "https://github.com/acme/widget/runs/123" });
  } } });
  await publishFailClosedCheck({ context: context(), octokit, message: "Review stopped at axes; no lanes completed." });
  expect(writes).toHaveLength(1);
  const check = z.object({
    conclusion: z.string(), output: z.object({ title: z.string(), summary: z.string() }),
  }).parse(writes[0]);
  expect(check.conclusion).toBe("action_required");
  expect(check.output.title).toContain("review incomplete");
  expect(check.output.summary).toContain("REVIEW INCOMPLETE");
  expect(check.output.summary).not.toContain("REVIEW COMPLETE");
  expect(check.output.summary).not.toContain("Reviewed base");
  expect(check.output.summary).toContain("Review stopped at axes; no lanes completed.");
});

test("rejects oversized inline findings before attempting publication", async () => {
  let requests = 0;
  const octokit = new Octokit({ request: { fetch: async () => { requests += 1; return json([]); } } });
  const oversized = report();
  oversized.findings = oversized.findings.map((finding) => ({ ...finding, evidence: ["x".repeat(65_001)] }));
  await expect(publishReview({ octokit, context: context(), report: oversized }))
    .rejects.toThrow("An inline finding exceeds");
  expect(requests).toBe(0);
});

test("head verification advances debounce once and preserves publication policy and later state", async () => {
  let body = encodeReviewState({
    schemaVersion: 2, app: "known-good-review", pullRequest: 7, initialFullStatus: "debouncing",
    publication: { blocking: true, profile: "thorough" }, baseline: null,
    updatedAt: "2026-09-04T00:00:00.000Z",
  });
  let writes = 0;
  const octokit = new Octokit({ request: { fetch: async (_resource: Request | string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return json([{ id: 1, user: botUser, body }]);
    writes += 1;
    body = z.object({ body: z.string() }).parse(JSON.parse(String(init?.body))).body;
    return json({ id: 1, user: botUser, body });
  } } });
  await markInitialReviewRunning(octokit, context());
  expect(decodeReviewState(body)).toMatchObject({
    initialFullStatus: "running", publication: { blocking: true, profile: "thorough" },
  });
  await markInitialReviewRunning(octokit, context());
  expect(writes).toBe(1);
  const running = decodeReviewState(body);
  if (!running) throw new Error("Expected running state");
  body = encodeReviewState({ ...running, initialFullStatus: "completed", baseline: {
    head: "head", patchFingerprint: "a".repeat(64), files: {},
    findingsArtifactUrl: "https://github.com/acme/widget/runs/1", report: report(),
  } });
  await markInitialReviewRunning(octokit, context());
  expect(decodeReviewState(body)?.baseline?.report).toEqual(report());
  expect(writes).toBe(1);
});

test("oversized staged reports can be corrected without issuing a GitHub request", async () => {
  const oversized = { ...report(), limitations: ["x".repeat(maxReviewStateBytes)] };
  const identity = {
    baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64),
    executionRevision: "review-report-v2" as const, planKind: "full" as const,
    repositoryId: "R_widget", pullRequest: 7,
    baselineHead: null, reviewPaths: [], activeAxes: ["engineering-quality" as const],
    selectedFindingIds: [],
  };
  const state = { ...beginReportAssembly(identity), report: oversized };
  let requests = 0;
  const octokit = new Octokit({ request: { fetch: async () => { requests += 1; return json([]); } } });
  let failure: unknown;
  try {
    await writeReviewState(octokit, context(), {
      schemaVersion: 2, app: "known-good-review", pullRequest: 7,
      initialFullStatus: "running", baseline: null,
      pendingPublication: { identity, report: oversized, stagedAt: oversized.generatedAt },
      updatedAt: oversized.generatedAt,
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ReviewReportValidationError);
  expect(reportAssemblyFailure(state, failure).report).toBeNull();
  expect(requests).toBe(0);
});

interface CapturedRequest {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;
}

function json(value: unknown): Response {
  return Response.json(value, {
    headers: { "content-type": "application/json" },
  });
}

function graphqlOperation(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "query" in body &&
    typeof body.query === "string"
  ) {
    return body.query;
  }
  return "";
}

function context(): TrustedGitHubContext {
  return {
    installationId: 1,
    owner: "acme",
    repo: "widget",
    repository: "acme/widget",
    repositoryId: "R_widget",
    repositoryCreatedAt: 0,
    pullRequest: 7,
    baseSha: "base",
    headSha: "head",
    patchFingerprint: "a".repeat(64),
  };
}

function report(): ReviewReport {
  return {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-08-17T18:00:00.000Z",
    verdict: "REQUEST_CHANGES",
    scope: {
      claim: "Publish native review feedback",
      base: "base",
      head: "head",
      dirtyState: "clean",
    },
    coverage: {
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
      ],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [
      {
        id: "CR-1",
        severity: "IMPORTANT",
        category: "QUALITY",
        title: "The feedback loses its code location",
        location: { path: "src/review.ts", line: 11, symbol: null },
        evidence: ["The result is only available on the timeline."],
        impact: "The author cannot discuss the affected code in place.",
        remedy: "Publish a native inline review thread.",
        status: "open",
        staticOnly: false,
        churn: null,
      },
    ],
    verifiedClaims: [],
    limitations: [],
  };
}

describe("GitHub publication lifecycle", () => {
  test("requires every file identity before publishing any result", async () => {
    const writes: string[] = [];
    const octokit = new Octokit({ auth: "test-token", request: {
      fetch: async (resource: Request | string | URL, init?: RequestInit) => {
        const path = new URL(String(resource)).pathname;
        const method = init?.method ?? "GET";
        if (method !== "GET") writes.push(`${method} ${path}`);
        if (path.endsWith("/pulls/7")) return json({ state: "open", draft: false, base: { sha: "base" }, head: { sha: "head" } });
        if (path.endsWith("/files")) return json([{ filename: "src/a.ts", status: "modified" }]);
        return json([]);
      },
    } });
    await expect(publishReview({ context: context(), octokit, report: report(), reconcileFindings: false }))
      .rejects.toThrow("did not return content identity");
    expect(writes).toEqual([]);
  });

  test("rechecks the PR after file pagination and before saving its baseline", async () => {
    for (const changedOnRead of [2, 3]) {
      let headReads = 0;
      const writes: string[] = [];
      const octokit = new Octokit({ auth: "test-token", request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const path = new URL(String(resource)).pathname;
          const method = init?.method ?? "GET";
          if (method !== "GET") writes.push(`${method} ${path}`);
          if (path.endsWith("/pulls/7")) return json({
            state: "open", draft: false, base: { sha: "base" },
            head: { sha: ++headReads >= changedOnRead ? "new-head" : "head" },
          });
          if (path.endsWith("/files")) return json([]);
          if (method === "GET" && path.endsWith("/check-runs")) return json({ check_runs: [] });
          if (method === "POST" && path.endsWith("/check-runs")) return json({ id: 1, html_url: "https://github.com/acme/widget/runs/1" });
          if (method === "GET" && path.endsWith("/issues/7/comments")) return json([]);
          if (method === "POST" && path.endsWith("/issues/7/comments")) return json({ id: 401, user: botUser });
          throw new Error(`Unexpected request: ${method} ${path}`);
        },
      } });
      await expect(publishReview({ context: context(), octokit, report: report(), reconcileFindings: false }))
        .rejects.toThrow("no longer matches the reviewable pull request");
      expect(headReads).toBe(changedOnRead);
      expect(writes).toEqual([]);
    }
  });

  test("rejects a stale or no longer reviewable PR before any publication write", async () => {
    for (const current of [
      { state: "open", draft: false, base: { sha: "base" }, head: { sha: "new-head" } },
      { state: "open", draft: false, base: { sha: "new-base" }, head: { sha: "head" } },
      { state: "open", draft: true, base: { sha: "base" }, head: { sha: "head" } },
      { state: "closed", draft: false, base: { sha: "base" }, head: { sha: "head" } },
    ]) {
      const writes: string[] = [];
      const octokit = new Octokit({ auth: "test-token", request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const path = new URL(String(resource)).pathname;
          const method = init?.method ?? "GET";
          if (method !== "GET") writes.push(`${method} ${path}`);
          if (path.endsWith("/pulls/7")) return json(current);
          return json([]);
        },
      } });
      await expect(publishReview({ context: context(), octokit, report: report() }))
        .rejects.toThrow("no longer matches the reviewable pull request");
      expect(writes).toEqual([]);
    }
  });

  test("never reads or overwrites another author's copied state marker", async () => {
    const state = {
      schemaVersion: 2 as const,
      app: "known-good-review" as const,
      pullRequest: 7,
      initialFullStatus: "running" as const,
      baseline: null,
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const body = encodeReviewState(state);
    const writes: string[] = [];
    const octokit = new Octokit({
      auth: "test-token",
      request: { fetch: async (resource: Request | string | URL, init?: RequestInit) => {
        const path = new URL(String(resource)).pathname;
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return json([{ id: 666, body, user: { login: "contributor", type: "User" } }]);
        }
        writes.push(`${method} ${path}`);
        return json({ id: 401, body, user: botUser });
      } },
    });
    expect(await readLatestReviewState(octokit, context())).toBeNull();
    await writeReviewState(octokit, context(), state);
    expect(writes).toEqual(["POST /repos/acme/widget/issues/7/comments"]);
  });

  test("stages a validated current-head report without advancing the baseline", async () => {
    const requests: CapturedRequest[] = [];
    const publicationContext = {
      ...context(),
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    };
    const baselineHead = "3".repeat(40);
    const baselineReport = {
      ...report(),
      scope: { ...report().scope, head: baselineHead },
    };
    const existingState = encodeReviewState({
      schemaVersion: 2,
      app: "known-good-review",
      pullRequest: publicationContext.pullRequest,
      initialFullStatus: "completed",
      baseline: {
        head: baselineHead,
        patchFingerprint: "b".repeat(64),
        findingsArtifactUrl: "https://github.com/acme/widget/runs/40",
        files: {},
        report: baselineReport,
      },
      updatedAt: "2026-08-23T01:00:00.000Z",
    });
    const pendingReport = {
      ...report(),
      scope: {
        ...report().scope,
        base: publicationContext.baseSha,
        head: publicationContext.headSha,
      },
      coverage: {
        ...report().coverage,
        activeAxes: ["engineering-quality" as const],
      },
    };
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([{ id: 401, user: botUser, body: existingState }]);
          }
          if (method === "PATCH" && url.pathname.endsWith("/issues/comments/401")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await stageReviewPublication({
      context: publicationContext,
      identity: {
        executionRevision: "review-report-v2",
          baselineHead,
          reviewPaths: ["src/review.ts"],
        repositoryId: publicationContext.repositoryId,
        pullRequest: publicationContext.pullRequest,
        baseSha: publicationContext.baseSha,
        headSha: publicationContext.headSha,
        patchFingerprint: publicationContext.patchFingerprint ?? "",
        planKind: "delta",
        activeAxes: ["engineering-quality"],
        selectedFindingIds: ["CR-1"],
      },
      octokit,
      report: pendingReport,
    });

    const update = requests.find(
      (request) =>
        request.method === "PATCH" &&
        request.path.endsWith("/issues/comments/401"),
    )?.body as { readonly body?: string } | undefined;
    const staged = decodeReviewState(update?.body ?? "");
    expect(staged?.baseline?.head).toBe(baselineHead);
    expect(staged?.pendingPublication?.report.scope.head).toBe(
      publicationContext.headSha,
    );
  });

  test("persists a current-head recovery failure without inventing review output", async () => {
    const requests: CapturedRequest[] = [];
    const failureContext = {
      ...context(),
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    };
    const recovery = advanceReviewRecovery(
      advanceReviewRecovery(
        advanceReviewRecovery(
          beginReviewRecovery({
            activeAxes: ["engineering-quality"],
            identity: {
              baseSha: failureContext.baseSha,
              headSha: failureContext.headSha,
              patchFingerprint: failureContext.patchFingerprint ?? "",
              planKind: "delta",
            },
            selectedFindingIds: ["CR-7"],
          }),
          {
            completedAxes: ["engineering-quality"],
            stage: "axes-complete",
          },
        ),
        {
          stage: "revalidation-complete",
        },
      ),
      {
        stage: "report-reconciled",
      },
    );
    const baselineHead = "3".repeat(40);
    const pendingReport: ReviewReport = {
      ...report(),
      scope: {
        ...report().scope,
        base: failureContext.baseSha,
        head: failureContext.headSha,
      },
      coverage: {
        ...report().coverage,
        activeAxes: ["engineering-quality"],
      },
    };
    const existingState = encodeReviewState({
      schemaVersion: 2,
      app: "known-good-review",
      pullRequest: failureContext.pullRequest,
      initialFullStatus: "completed",
      baseline: {
        head: baselineHead,
        patchFingerprint: "b".repeat(64),
        findingsArtifactUrl: "https://github.com/acme/widget/runs/40",
        files: {},
        report: { ...report(), scope: { ...report().scope, head: baselineHead } },
      },
      pendingPublication: {
        identity: {
          executionRevision: "review-report-v2",
          baselineHead,
          reviewPaths: ["src/review.ts"],
          repositoryId: failureContext.repositoryId,
          pullRequest: failureContext.pullRequest,
          baseSha: failureContext.baseSha,
          headSha: failureContext.headSha,
          patchFingerprint: failureContext.patchFingerprint ?? "",
          planKind: "delta",
          activeAxes: ["engineering-quality"],
          selectedFindingIds: ["CR-7"],
        },
        report: pendingReport,
        stagedAt: "2026-08-23T01:02:00.000Z",
      },
      updatedAt: "2026-08-23T01:02:00.000Z",
    });
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/pulls/7")) {
            return json({
              base: { sha: failureContext.baseSha },
              head: { sha: failureContext.headSha },
            });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([{ id: 401, user: botUser, body: existingState }]);
          }
          if (method === "PATCH" && url.pathname.endsWith("/issues/comments/401")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await writeReviewFailureState({
      context: failureContext,
      failure: buildReviewFailureEnvelope({
        errorClass: "WORKFLOW_INCOMPLETE",
        recovery,
        run: { sessionId: "session-safe", turnId: "turn-safe" },
      }),
      octokit,
    });

    const update = requests.find(
      (request) =>
        request.method === "PATCH" &&
        request.path.endsWith("/issues/comments/401"),
    )?.body as { readonly body?: string } | undefined;
    expect(update?.body).toContain("known-good-review:state");
    const updated = decodeReviewState(update?.body ?? "");
    expect(updated?.baseline?.head).toBe(baselineHead);
    expect(updated?.pendingPublication?.report.scope.head).toBe(
      failureContext.headSha,
    );
    expect(updated?.failure?.failedStage).toBe("publication");
  });

  test("round-trips current-head review identity through the Check Run", () => {
    const full = activeReviewExternalId(context(), {
      kind: "full",
      reason: "manual",
    });
    const delta = activeReviewExternalId(context(), { kind: "delta" });

    expect(parseActiveReviewExternalId(full, context())).toEqual({
      kind: "full",
      reason: "manual",
    });
    expect(parseActiveReviewExternalId(delta, context())).toEqual({
      kind: "delta",
    });
    expect(
      parseActiveReviewExternalId(full, { ...context(), headSha: "new-head" }),
    ).toBeNull();
    expect(
      parseActiveReviewExternalId(full, { ...context(), baseSha: "new-base" }),
    ).toBeNull();
    expect(
      parseActiveReviewExternalId(full, { ...context(), pullRequest: 8 }),
    ).toBeNull();
  });

  test("creates a fresh Check Run when the prior run is completed", async () => {
    const requests: CapturedRequest[] = [];
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({
              check_runs: [
                {
                  conclusion: "failure",
                  id: 91,
                  name: "known-good-review",
                  status: "completed",
                },
              ],
              total_count: 1,
            });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            return json({
              id: 92,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/92",
            });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishInProgressCheck({
      context: context(),
      octokit,
      review: { kind: "full", reason: "manual" },
    });

    expect(
      requests.find(
        (request) =>
          request.method === "POST" && request.path.endsWith("/check-runs"),
      )?.body,
    ).toMatchObject({ head_sha: "head", status: "in_progress" });
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" && request.path.endsWith("/check-runs/91"),
      ),
    ).toBeFalse();
  });

  test("moves one Check Run from in progress to a visible inline result", async () => {
    const requests: CapturedRequest[] = [];
    let checkExists = false;
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });

          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({
              check_runs: checkExists
                ? [{ id: 91, name: "known-good-review", status: "in_progress" }]
                : [],
              total_count: checkExists ? 1 : 0,
            });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            checkExists = true;
            return json({
              id: 91,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/91",
            });
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7")) {
            return json({ state: "open", draft: false, base: { sha: "base" }, head: { sha: "head" } });
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([
              {
                filename: "src/review.ts",
                status: "modified",
                sha: "blob",
                patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
              },
            ]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([{
              id: 666,
              user: { login: "contributor", type: "User" },
              body: findingBody(report().findings[0]!),
              path: "src/review.ts", line: 11, side: "RIGHT",
              in_reply_to_id: null,
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json([{ id: 77, state: "PENDING" }]);
          }
          if (
            method === "DELETE" &&
            url.pathname.endsWith("/pulls/7/reviews/77")
          ) {
            return json({ id: 77, state: "PENDING" });
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewAddReviewThread")) {
              return json({
                data: {
                  addPullRequestReviewThread: { thread: { id: "PRRT_102" } },
                },
              });
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/reviews/101/events")
          ) {
            return json({ id: 101, node_id: "PRR_101", state: "COMMENTED" });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([
              {
                id: 88,
                user: botUser,
                body: "<!-- known-good-review:finding:CR-2 -->\nlegacy finding",
              },
              {
                id: 666,
                user: { login: "contributor", type: "User" },
                body: "<!-- known-good-review:finding:CR-2 -->\ncopied marker",
              },
            ]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 102, body });
          }
          if (method === "PATCH" && url.pathname.endsWith("/issues/comments/88")) {
            return json({ id: 88, body });
          }
          if (method === "PATCH" && url.pathname.endsWith("/check-runs/91")) {
            return json({
              id: 91,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/91",
            });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishInProgressCheck({
      context: context(),
      octokit,
      review: { kind: "full", reason: "manual" },
    });
    await publishReview({ context: context(), octokit, report: report() });
    expect(requests.some((request) => request.path.endsWith("/666"))).toBeFalse();

    expect(
      requests.find(
        (request) =>
          request.method === "POST" && request.path.endsWith("/check-runs"),
      )?.body,
    ).toMatchObject({ status: "in_progress" });
    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path === "/graphql" &&
          graphqlOperation(request.body).includes(
            "KnownGoodReviewAddReviewThread",
          ),
      )?.body,
    ).toMatchObject({
      variables: {
        input: {
          body: expect.stringContaining(
            "### ⚠️ The feedback loses its code location",
          ),
          line: 11,
          path: "src/review.ts",
          pullRequestReviewId: "PRR_101",
          side: "RIGHT",
          subjectType: "LINE",
        },
      },
    });
    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path.endsWith("/pulls/7/reviews/77"),
      ),
    ).toBeTrue();
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/pulls/7/reviews/101/events") &&
          typeof request.body === "object" &&
          request.body !== null &&
          "event" in request.body &&
          request.body.event === "COMMENT",
      ),
    ).toBeTrue();
    expect(
      requests.find(
        (request) =>
          request.method === "PATCH" && request.path.endsWith("/check-runs/91"),
      )?.body,
    ).toMatchObject({ conclusion: "neutral", status: "completed" });
    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments"),
      )?.body,
    ).toMatchObject({
      body: expect.stringContaining(
        "## 🛑 Slop Sheriff: changes needed",
      ),
    });
    expect(
      requests.find(
        (request) =>
          request.method === "PATCH" &&
          request.path.endsWith("/issues/comments/88"),
      )?.body,
    ).toMatchObject({
      body: expect.stringContaining("### ✅ No longer active"),
    });
  });

  test("removes a pending review when native thread creation fails", async () => {
    const requests: CapturedRequest[] = [];
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });

          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) return json([]);
          if (method === "GET" && url.pathname.endsWith("/pulls/7")) {
            return json({ state: "open", draft: false, base: { sha: "base" }, head: { sha: "head" } });
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([
              {
                filename: "src/review.ts",
                status: "modified",
                sha: "blob",
                patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
              },
            ]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewAddReviewThread")) {
              return json({
                data: { addPullRequestReviewThread: null },
                errors: [{ message: "native thread creation failed" }],
              });
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (
            method === "DELETE" &&
            url.pathname.endsWith("/pulls/7/reviews/101")
          ) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    expect(
      publishReview({ context: context(), octokit, report: report() }),
    ).rejects.toThrow("native thread creation failed");
    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path.endsWith("/pulls/7/reviews/101"),
      ),
    ).toBeTrue();
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/pulls/7/reviews/101/events"),
      ),
    ).toBeFalse();
  });

  test("leaves untracked legacy threads open when a new full review reuses the CR number", async () => {
    const requests: CapturedRequest[] = [];
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/pulls/7")) {
            return json({ state: "open", draft: false, base: { sha: "base" }, head: { sha: "head" } });
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([{
              filename: "src/review.ts",
              status: "modified",
              sha: "blob",
              patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([{
              id: 201,
              user: botUser,
              body: "<!-- known-good-review:finding:CR-1 -->\nold finding",
              path: "src/old.ts",
              line: 3,
              side: "RIGHT",
              subject_type: "line",
              in_reply_to_id: null,
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/reviews/101/events")
          ) {
            return json({ id: 101, state: "COMMENTED" });
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/comments/201/replies")
          ) {
            return json({ id: 202, body, in_reply_to_id: 201 });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewThreads")) {
              return json({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [{
                          id: "PRRT_201",
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 201, body: "old finding" }] },
                        }],
                        pageInfo: { endCursor: null, hasNextPage: false },
                      },
                    },
                  },
                },
              });
            }
            if (operation.includes("KnownGoodReviewAddReviewThread")) {
              return json({
                data: {
                  addPullRequestReviewThread: { thread: { id: "PRRT_202" } },
                },
              });
            }
            if (operation.includes("KnownGoodReviewResolveThread")) {
              throw new Error("review thread resolution failed");
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({ check_runs: [], total_count: 0 });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            return json({
              id: requests.length + 300,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/300",
            });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishReview({ context: context(), octokit, report: report() });

    const stateArtifact = requests.findIndex(
      (request) =>
        request.method === "POST" &&
        request.path.endsWith("/issues/7/comments") &&
        typeof request.body === "object" &&
        request.body !== null &&
        "body" in request.body &&
        typeof request.body.body === "string" &&
        request.body.body.includes("known-good-review:state"),
    );
    const retirementReply = requests.findIndex((request) =>
      request.path.endsWith("/pulls/7/comments/201/replies"),
    );
    expect(stateArtifact).toBeGreaterThan(-1);
    expect(retirementReply).toBe(-1);
    expect(requests.some((request) => graphqlOperation(request.body).includes("KnownGoodReviewResolveThread"))).toBeFalse();
  });

  test("replies to and resolves a fixed finding without reposting it", async () => {
    const requests: CapturedRequest[] = [];
    const fixed = report();
    fixed.findings[0]!.status = "fixed";
    fixed.verdict = "APPROVE";
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/pulls/7")) {
            return json({ state: "open", draft: false, base: { sha: "base" }, head: { sha: "head" } });
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([{
              filename: "src/review.ts",
              status: "modified",
              sha: "blob",
              patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([{
              id: 201,
              user: botUser,
              body: findingBody(fixed.findings[0]!),
              path: "src/review.ts",
              line: 11,
              side: "RIGHT",
              subject_type: "line",
              in_reply_to_id: null,
            }]);
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/comments/201/replies")
          ) {
            return json({ id: 202, body, in_reply_to_id: 201 });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewThreads")) {
              return json({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [{
                          id: "PRRT_201",
                          isResolved: false,
                          comments: {
                            nodes: [{ databaseId: 201, body: "original finding" }],
                          },
                        }],
                        pageInfo: { endCursor: null, hasNextPage: false },
                      },
                    },
                  },
                },
              });
            }
            if (operation.includes("KnownGoodReviewResolveThread")) {
              return json({
                data: {
                  resolveReviewThread: {
                    thread: { id: "PRRT_201", isResolved: true },
                  },
                },
              });
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({ check_runs: [], total_count: 0 });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            return json({
              id: requests.length + 300,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/300",
            });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishReview({ context: context(), octokit, report: fixed });

    expect(
      requests.find((request) =>
        request.path.endsWith("/pulls/7/comments/201/replies"),
      )?.body,
    ).toMatchObject({ body: expect.stringContaining("✅ Verified fixed in [head](https://github.com/acme/widget/commit/head).") });
    expect(
      requests.some(
        (request) =>
          request.path === "/graphql" &&
          graphqlOperation(request.body).includes("KnownGoodReviewResolveThread"),
      ),
    ).toBeTrue();
    expect(
      requests.some((request) => request.path.endsWith("/pulls/7/reviews")),
    ).toBeFalse();
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.path.endsWith("/pulls/comments/201"),
      ),
    ).toBeFalse();
  });
});
