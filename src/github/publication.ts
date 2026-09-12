import type { Octokit } from "@octokit/rest";
import { isReviewBotComment } from "./comment-identity";
import { renderPlainText } from "./deterministic-presentation";
import { parsePullRequestFiles } from "./inbound";
import type { ReviewConfig } from "../config/review-config";
import {
  decodeReviewState,
  prepareReviewStateComments,
  reviewStateCommentLimit,
  isReviewStateComment,
  type ReviewState,
} from "./review-state";
import type { TrustedGitHubContext } from "./trusted-context";
import {
  findingIsOutstanding,
  reviewReportSchema,
  type ReviewFinding,
  type ReviewReport,
} from "../review/findings";
import { effectivePatchFileFingerprints } from "../review/effective-patch";
import {
  findingBody,
  publishedFindings,
  reviewFindingCountSummary,
  nativeReviewBody,
} from "./review-presentation";
import { laneCheckName, reviewLaneRegistry } from "../review/project-lanes";
import type { ReviewAxis } from "../review/axes";
import { findingIdentity, preserveFindingDismissals } from "../review/finding-identity";
import type { ReviewFailureEnvelope } from "../review/recovery";
import {
  reportAssemblyIdentitySchema,
  ReviewReportValidationError,
  type ReportAssemblyIdentity,
} from "../review/report-assembly";

export { findingBody } from "./review-presentation";

function validateFindingPresentation(report: ReviewReport): void {
  for (const [index, finding] of report.findings.entries()) {
    if (!findingIsOutstanding(finding)) continue;
    let body: string;
    try {
      // The formatter enforces the complete visible word budget before storage.
      body = findingBody(finding, "file");
    } catch (error) {
      throw new ReviewReportValidationError(
        [{ code: "custom", path: ["findings", index] }],
        error instanceof Error ? error.message : "Finding presentation is invalid",
      );
    }
    if (Buffer.byteLength(body, "utf8") > reviewStateCommentLimit) {
      throw new ReviewReportValidationError(
        [{ code: "too_big", path: ["findings", index] }],
        "An inline finding exceeds GitHub comment storage; shorten its text before retrying",
      );
    }
  }
}

export const checkName = "slop-sheriff";
export const legacyCheckName = "known-good-review";
export const reviewCheckNames = [checkName, legacyCheckName] as const;
export function axisCheckName(axis: ReviewAxis, config?: Pick<ReviewConfig, "lanes">): string {
  return laneCheckName(axis, config);
}

export type ActiveReviewIdentity =
  | { readonly kind: "delta" }
  | { readonly kind: "full"; readonly reason: "initial" | "manual" };

export function activeReviewExternalId(
  context: Pick<TrustedGitHubContext, "baseSha" | "headSha" | "pullRequest" | "deliveryId">,
  review: ActiveReviewIdentity,
): string {
  return [
    legacyCheckName,
    context.pullRequest,
    context.baseSha,
    context.headSha,
    review.kind,
    review.kind === "full" ? review.reason : "none",
    ...(context.deliveryId ? [context.deliveryId] : []),
  ].join(":");
}

export function parseActiveReviewExternalId(
  externalId: string | null | undefined,
  expected: Pick<
    TrustedGitHubContext,
    "baseSha" | "headSha" | "pullRequest"
  >,
): ActiveReviewIdentity | null {
  if (!externalId) return null;
  const [name, pullRequest, baseSha, headSha, kind, reason, deliveryId, extra] =
    externalId.split(":");
  if (
    extra !== undefined ||
    (deliveryId !== undefined && !/^[A-Za-z0-9._-]+$/.test(deliveryId)) ||
    !reviewCheckNames.some((candidate) => candidate === name) ||
    pullRequest !== String(expected.pullRequest) ||
    baseSha !== expected.baseSha ||
    headSha !== expected.headSha
  ) {
    return null;
  }
  if (kind === "delta" && reason === "none") return { kind };
  if (kind === "full" && (reason === "initial" || reason === "manual")) {
    return { kind, reason };
  }
  return null;
}

const addReviewThreadMutation = `
  mutation KnownGoodReviewAddReviewThread(
    $input: AddPullRequestReviewThreadInput!
  ) {
    addPullRequestReviewThread(input: $input) {
      thread {
        id
      }
    }
  }
`;

const reviewThreadsQuery = `
  query KnownGoodReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
                body
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

const resolveReviewThreadMutation = `
  mutation KnownGoodReviewResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

type OctokitClient = Octokit;

function resolutionReplyBody(
  id: string,
  context: TrustedGitHubContext,
  reason: "fixed" | "moved" | "dismissed",
  evidence?: string,
): string {
  const commit = `[${context.headSha.slice(0, 7)}](https://github.com/${context.repository}/commit/${context.headSha})`;
  const prefix = reason === "fixed"
    ? `✅ Verified fixed in ${commit}.`
    : reason === "dismissed" ? `☑️ Dismissed in ${commit}.`
    : `↪️ This finding moved to a new inline location in ${commit}.`;
  // Keep the human reply short while linking the exact reviewed commit.
  const detail = evidence ? renderPlainText(evidence.replaceAll(/\s+/g, " ").trim()) : undefined;
  const available = Math.max(0, 299 - prefix.length);
  const summary = detail && available > 1
    ? ` ${detail.length <= available ? detail : `${detail.slice(0, available - 1).trimEnd()}…`}`
    : "";
  return [
    `<!-- known-good-review:resolution:${id}:${context.headSha}:${reason} -->`,
    `${prefix}${summary}`,
  ].join("\n");
}

function retiredTimelineFindingBody(id: string): string {
  return [
    `<!-- known-good-review:retired-finding:${id} -->`,
    "### ↪️ Finding moved inline",
    "",
    "The finding is now available as an inline review thread on the changed file.",
  ].join("\n");
}

function inactiveTimelineFindingBody(id: string): string {
  return [
    `<!-- known-good-review:retired-finding:${id} -->`,
    "### ✅ No longer active",
    "",
    "The current Slop Sheriff result no longer reports this finding.",
  ].join("\n");
}

interface FindingMarker {
  readonly id: string;
  readonly identity: string | null;
}

function findingMarker(body: string | null | undefined): FindingMarker | null {
  const current = body?.match(
    /<!-- known-good-review:finding:v2:([a-f0-9]{64}):(CR-[1-9]\d*) -->/,
  );
  if (current?.[1] && current[2]) {
    return { identity: current[1], id: current[2] };
  }
  const legacy = body?.match(
    /<!-- known-good-review:finding:(CR-[1-9]\d*) -->/,
  );
  return legacy?.[1] ? { identity: null, id: legacy[1] } : null;
}

function timelineMarkerId(body: string | null | undefined): string | null {
  return body?.match(
    /<!-- known-good-review:(?:finding|retired-finding):(CR-[1-9]\d*) -->/,
  )?.[1] ?? null;
}

function hasBlockingFinding(report: ReviewReport): boolean {
  return report.findings.some(
    (finding) =>
      findingIsOutstanding(finding) &&
      (finding.severity === "BLOCKING" || finding.severity === "IMPORTANT"),
  );
}

function conclusionFor(
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking">,
): "failure" | "neutral" | "success" {
  if (config.blocking && hasBlockingFinding(report)) return "failure";
  if (report.findings.some((finding) => findingIsOutstanding(finding))) return "neutral";
  return "success";
}

function checkSummary(
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile"> & Partial<Pick<ReviewConfig, "personality" | "voice" | "lanes">>,
): string {
  const published = publishedFindings(report, config.profile);
  const active = report.findings.filter((finding) => findingIsOutstanding(finding));
  return [
    `Policy result: **${hasBlockingFinding(report) ? "CHANGES NEEDED" : "CLEAR"}**`,
    "",
    reviewFindingCountSummary(report, config.profile),
    `Published inline: **${published.length} of ${active.length} active findings**`,
    "",
    `Reviewed ${report.scope.base}…${report.scope.head} with ${report.coverage.activeAxes.join(", ")}.`,
    ...report.limitations.length > 0
      ? ["", "Limitations:", ...report.limitations.map((item) => `- ${item}`)]
      : [],
  ].join("\n");
}

async function latestCheck(
  octokit: OctokitClient,
  context: Omit<TrustedGitHubContext, "patchFingerprint">,
  name = checkName,
) {
  const names = [name, name.replace(/^slop-sheriff(?= \/|$)/, legacyCheckName)];
  const listed = await Promise.all([...new Set(names)].map((check_name) =>
    octokit.rest.checks.listForRef({
      owner: context.owner,
      repo: context.repo,
      ref: context.headSha,
      check_name,
      per_page: 100,
    }),
  ));
  return listed.flatMap((page) => page.data.check_runs)
    .filter((check) => names.includes(check.name))
    .sort((left, right) => right.id - left.id)[0];
}

async function upsertCheck(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile"> & Partial<Pick<ReviewConfig, "personality" | "voice" | "lanes">>,
  forcedConclusion?: "action_required",
) {
  const existing = await latestCheck(octokit, context);
  const common = {
    owner: context.owner,
    repo: context.repo,
    name: checkName,
    status: "completed" as const,
    conclusion: forcedConclusion ?? conclusionFor(report, config),
    completed_at: new Date().toISOString(),
    output: {
      title: forcedConclusion === "action_required"
        ? "Slop Sheriff: review incomplete"
        : hasBlockingFinding(report)
        ? "Slop Sheriff: changes needed"
        : "Slop Sheriff: review complete",
      summary: (forcedConclusion === "action_required"
        ? [
          "Policy result: **REVIEW INCOMPLETE**",
          "",
          "No review verdict was published.",
          "",
          ...report.limitations,
        ].join("\n")
        : checkSummary(report, config)).slice(0, 65_535),
    },
  };
  if (existing) {
    return (
      await octokit.rest.checks.update({
        ...common,
        check_run_id: existing.id,
      })
    ).data;
  }
  return (
    await octokit.rest.checks.create({
      ...common,
      head_sha: context.headSha,
      external_id: `${checkName}:${context.pullRequest}:${context.headSha}`,
    })
  ).data;
}

export async function publishInProgressCheck(input: {
  readonly config?: Pick<ReviewConfig, "lanes">;
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly octokit: OctokitClient;
  readonly review: ActiveReviewIdentity;
  readonly activeAxes?: readonly ReviewAxis[];
  readonly skippedAxes?: readonly ReviewAxis[];
}): Promise<string> {
  const existing = await latestCheck(input.octokit, input.context);
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name: checkName,
    external_id: activeReviewExternalId(input.context, input.review),
    status: "in_progress" as const,
    started_at: new Date().toISOString(),
    output: {
      title: "Slop Sheriff: review in progress",
      summary: `A ${input.review.kind} review was accepted and is currently running.`,
    },
  };
  const check = existing && existing.status !== "completed"
    ? (
        await input.octokit.rest.checks.update({
          ...common,
          check_run_id: existing.id,
        })
      ).data
    : (
        await input.octokit.rest.checks.create({
          ...common,
          head_sha: input.context.headSha,
        })
      ).data;
  await Promise.all([
    ...(input.activeAxes ?? []).map((axis) =>
      upsertAxisCheck({
        config: input.config,
        axis,
        conclusion: null,
        context: input.context,
        octokit: input.octokit,
        summary: "This review axis is running.",
      }),
    ),
    ...(input.skippedAxes ?? []).map((axis) =>
      upsertAxisCheck({
        config: input.config,
        axis,
        conclusion: "skipped",
        context: input.context,
        octokit: input.octokit,
        summary: "This conditional review axis does not apply to the current change.",
      }),
    ),
  ]);
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
  );
}

async function upsertAxisCheck(input: {
  readonly config?: Pick<ReviewConfig, "lanes"> | undefined;
  readonly axis: ReviewAxis;
  readonly conclusion: "action_required" | "skipped" | "success" | null;
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly octokit: OctokitClient;
  readonly summary: string;
}): Promise<void> {
  const name = axisCheckName(input.axis, input.config);
  const existing = await latestCheck(input.octokit, input.context, name);
  const completed = input.conclusion !== null;
  if (existing?.status === "completed" && completed) {
    return;
  }
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name,
    status: completed ? ("completed" as const) : ("in_progress" as const),
    ...(completed
      ? {
          conclusion: input.conclusion,
          completed_at: new Date().toISOString(),
        }
      : { started_at: new Date().toISOString() }),
    output: {
      title: `${input.axis}: ${completed ? input.conclusion?.replaceAll("_", " ") : "in progress"}`,
      summary: input.summary,
    },
  };
  if (existing && existing.status !== "completed") {
    await input.octokit.rest.checks.update({
      ...common,
      check_run_id: existing.id,
    });
    return;
  }
  await input.octokit.rest.checks.create({
    ...common,
    head_sha: input.context.headSha,
    external_id: `${name}:${input.context.pullRequest}:${input.context.headSha}`,
  });
}

export async function publishAxisCheckpoint(input: {
  readonly config?: Pick<ReviewConfig, "lanes">;
  readonly axis: ReviewAxis;
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly octokit: OctokitClient;
  readonly status: "complete" | "in-progress";
}): Promise<void> {
  await upsertAxisCheck({
    config: input.config,
    axis: input.axis,
    conclusion: input.status === "complete" ? "success" : null,
    context: input.context,
    octokit: input.octokit,
    summary:
      input.status === "complete"
        ? "This review axis completed its evidence coverage. Findings are summarized by the aggregate review."
        : "This review axis saved progress and is continuing in a fresh context.",
  });
}

async function completeAxisChecks(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
  config: Pick<ReviewConfig, "lanes">,
): Promise<void> {
  const active = new Set(report.coverage.activeAxes);
  await Promise.all(
    reviewLaneRegistry(config).map(({id: axis}) =>
      upsertAxisCheck({
        config,
        axis,
        conclusion: active.has(axis) ? "success" : "skipped",
        context,
        octokit,
        summary: active.has(axis)
          ? "This review axis completed its evidence coverage. Findings are summarized by the aggregate review."
          : "This conditional review axis did not run for the current change.",
      }),
    ),
  );
}

interface PullRequestFileForComment {
  readonly filename: string;
  readonly patch?: string;
  readonly status: string;
}

export type ReviewCommentLocation =
  | { readonly subjectType: "file" }
  | {
      readonly line: number;
      readonly side: "LEFT" | "RIGHT";
      readonly subjectType: "line";
    };

function commentableLines(patch: string): {
  readonly left: ReadonlySet<number>;
  readonly right: ReadonlySet<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const patchLine of patch.split("\n")) {
    const header = patchLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header?.[1] && header[2]) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (oldLine === null || newLine === null || patchLine.startsWith("\\")) {
      continue;
    }
    if (patchLine.startsWith("+")) {
      right.add(newLine);
      newLine += 1;
      continue;
    }
    if (patchLine.startsWith("-")) {
      left.add(oldLine);
      oldLine += 1;
      continue;
    }
    left.add(oldLine);
    right.add(newLine);
    oldLine += 1;
    newLine += 1;
  }
  return { left, right };
}

export function reviewCommentLocation(
  finding: ReviewFinding,
  files: readonly PullRequestFileForComment[],
): ReviewCommentLocation {
  const file = files.find(
    (candidate) => candidate.filename === finding.location.path,
  );
  if (!file?.patch) return { subjectType: "file" };
  const lines = commentableLines(file.patch);
  if (file.status === "removed" && lines.left.has(finding.location.line)) {
    return {
      line: finding.location.line,
      side: "LEFT",
      subjectType: "line",
    };
  }
  if (lines.right.has(finding.location.line)) {
    return {
      line: finding.location.line,
      side: "RIGHT",
      subjectType: "line",
    };
  }
  return { subjectType: "file" };
}

function sameCommentLocation(
  existing: {
    readonly line?: number | null;
    readonly path: string;
    readonly side?: string | null;
    readonly subject_type?: string | null;
  },
  finding: ReviewFinding,
  location: ReviewCommentLocation,
): boolean {
  if (existing.path !== finding.location.path) return false;
  if (location.subjectType === "file") return existing.subject_type === "file";
  return existing.line === location.line && existing.side === location.side;
}

interface NewReviewThread {
  readonly body: string;
  readonly finding: ReviewFinding;
  readonly location: ReviewCommentLocation;
}

async function deleteViewerPendingReviews(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
): Promise<void> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    per_page: 100,
  });
  for (const review of reviews) {
    if (review.state !== "PENDING") continue;
    await octokit.rest.pulls.deletePendingReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullRequest,
      review_id: review.id,
    });
  }
}

async function createReviewThreads(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  threads: readonly NewReviewThread[],
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile"> & Partial<Pick<ReviewConfig, "personality" | "voice" | "lanes">>,
): Promise<void> {
  if (threads.length === 0 && !config.blocking) return;
  await verifyPublicationHead(octokit, context);
  await deleteViewerPendingReviews(octokit, context);
  const created = await octokit.rest.pulls.createReview({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    commit_id: context.headSha,
  });
  const pullRequestReviewId = created.data.node_id;
  if (!pullRequestReviewId) {
    throw new Error("GitHub did not return the pending review identity");
  }
  try {
    for (const thread of threads) {
      await octokit.graphql(addReviewThreadMutation, {
        input: {
          body: thread.body,
          path: thread.finding.location.path,
          pullRequestReviewId,
          subjectType:
            thread.location.subjectType === "line" ? "LINE" : "FILE",
          ...(thread.location.subjectType === "line"
            ? {
                line: thread.location.line,
                side: thread.location.side,
              }
            : {}),
        },
      });
    }
    const event = config.blocking
      ? hasBlockingFinding(report)
        ? "REQUEST_CHANGES" as const
        : "APPROVE" as const
      : "COMMENT" as const;
    await verifyPublicationHead(octokit, context);
    await octokit.rest.pulls.submitReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullRequest,
      review_id: created.data.id,
      event,
      ...(event === "APPROVE"
        ? {}
        : { body: nativeReviewBody(report, config).slice(0, 65_535) }),
    });
  } catch (error) {
    try {
      await octokit.rest.pulls.deletePendingReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullRequest,
        review_id: created.data.id,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "GitHub review publication and pending-review cleanup both failed",
      );
    }
    throw error;
  }
}

interface ReviewThreadIdentity {
  readonly commentIds: readonly number[];
  readonly id: string;
  readonly isResolved: boolean;
}

async function reviewThreadIdentities(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
): Promise<ReviewThreadIdentity[]> {
  const threads: ReviewThreadIdentity[] = [];
  let after: string | null = null;
  for (;;) {
    const response: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              comments: { nodes: Array<{ databaseId: number | null; body: string }> };
            }>;
            pageInfo: { endCursor: string | null; hasNextPage: boolean };
          };
        };
      };
    } = await octokit.graphql(reviewThreadsQuery, {
      owner: context.owner,
      repo: context.repo,
      number: context.pullRequest,
      after,
    });
    const connection: {
      nodes: Array<{
        id: string;
        isResolved: boolean;
        comments: { nodes: Array<{ databaseId: number | null; body: string }> };
      }>;
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    } = response.repository.pullRequest.reviewThreads;
    threads.push(
      ...connection.nodes.map((thread) => ({
        id: thread.id,
        isResolved: thread.isResolved,
        commentIds: thread.comments.nodes.flatMap((comment) =>
          comment.databaseId === null ? [] : [comment.databaseId],
        ),
      })),
    );
    if (!connection.pageInfo.hasNextPage) return threads;
    after = connection.pageInfo.endCursor;
    if (!after) throw new Error("GitHub review-thread pagination lost its cursor");
  }
}

function deliveryFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const status = "status" in error && typeof error.status === "number" ? ` HTTP ${error.status}` : "";
  const codes = "errors" in error && Array.isArray(error.errors)
    ? error.errors.flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null || !("type" in item) || typeof item.type !== "string") return [];
        return /^[A-Z_]+$/.test(item.type) ? [item.type] : [];
      })
    : [];
  return `${error.name}${status}${codes.length ? ` [${[...new Set(codes)].join(", ")}]` : ""}`;
}

function threadDeliveryFailure(failures: unknown[]): AggregateError {
  return new AggregateError(failures, `Review thread delivery is incomplete: ${failures.map((error) => error instanceof Error ? error.message : "unknown failure").join("; ")}`);
}

async function replyAndResolveFinding(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  comments: readonly { readonly body?: string | null; readonly id: number; readonly in_reply_to_id?: number | null }[],
  roots: readonly { readonly body?: string | null; readonly id: number }[],
  finding: ReviewFinding,
  reason: "fixed" | "moved" | "dismissed",
  threads: readonly ReviewThreadIdentity[],
): Promise<void> {
  const body = resolutionReplyBody(finding.id, context, reason, reason === "fixed" ? finding.resolutionSummary ?? finding.evidence[0] : reason === "dismissed" ? `Accepted by @${finding.dismissal!.actor}: ${finding.dismissal!.reason}` : undefined);
  const failures: unknown[] = [];
  for (const root of roots) {
    const thread = threads.find((candidate) => candidate.commentIds.includes(root.id));
    if (!thread) {
      failures.push(new Error(`Review thread for comment ${root.id} was not returned by GitHub`));
      continue;
    }
    if (thread.isResolved) continue;
    try {
      await verifyPublicationHead(octokit, context);
      const alreadyReplied = comments.some((comment) =>
        comment.in_reply_to_id === root.id &&
        comment.body?.includes(`known-good-review:resolution:${finding.id}:${context.headSha}:${reason}`),
      );
      if (!alreadyReplied) {
        await octokit.rest.pulls.createReplyForReviewComment({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullRequest,
          comment_id: root.id,
          body,
        });
      }
      // A new push between the reply and resolution must leave the thread open.
      await verifyPublicationHead(octokit, context);
      const result = await octokit.graphql<{
        resolveReviewThread: { thread: { id: string; isResolved: boolean } } | null;
      }>(resolveReviewThreadMutation, { threadId: thread.id });
      if (result.resolveReviewThread?.thread.id !== thread.id || !result.resolveReviewThread.thread.isResolved) {
        throw new Error("GitHub did not confirm thread resolution");
      }
    } catch (cause) {
      failures.push(new Error(`Review thread delivery failed for ${thread.id} (${finding.id}): ${deliveryFailureCode(cause)}`, { cause }));
    }
  }
  if (failures.length > 0) throw threadDeliveryFailure(failures);
}

/** CR numbers are stable inside a delta lineage, but are reused by full reviews. */
function findingPublicationMetadata(
  report: ReviewReport,
  state: ReviewState | null,
  context: TrustedGitHubContext,
): { identities: Record<string, string>; runtimeRequirements: Record<string, boolean>; prior: ReviewReport | null } {
  const pending = state?.pendingPublication;
  const baseline = state?.baseline;
  let prior: ReviewReport | null = null;
  if (pending && JSON.stringify(pending.report) === JSON.stringify(reviewReportSchema.parse(report))) {
    validateReportPublicationIdentity(context, pending.identity);
    if (pending.identity.planKind === "delta" && pending.identity.baselineHead === baseline?.head) {
      prior = baseline.report;
    }
  } else if (!pending && baseline?.head === context.headSha && JSON.stringify(baseline.report) === JSON.stringify(reviewReportSchema.parse(report))) {
    prior = baseline.report;
  }
  const priorById = new Map(prior?.findings.map((finding) => [finding.id, finding] as const));
  const identities = Object.fromEntries(report.findings.map((finding) => {
    const previous = priorById.get(finding.id);
    return [finding.id, previous
      ? baseline?.findingThreadIdentities?.[finding.id] ?? findingIdentity(previous)
      : findingIdentity(finding)];
  }));
  const runtimeRequirements = Object.fromEntries(report.findings.map((finding) => {
    const previous = priorById.get(finding.id);
    return [finding.id, !finding.staticOnly || (previous !== undefined &&
      (!previous.staticOnly || baseline?.findingRuntimeRequirements?.[finding.id] === true))];
  }));
  // A deferred source-only result cannot erase an earlier runtime requirement.
  for (const finding of report.findings) {
    if (finding.status === "fixed" && finding.staticOnly && runtimeRequirements[finding.id]) {
      throw new ReviewReportValidationError(
        [{ code: "custom", path: ["findings", report.findings.indexOf(finding), "status"] }],
        `${finding.id} requires runtime revalidation; keep it deferred until execution is available`,
      );
    }
  }
  return { identities, runtimeRequirements, prior };
}

async function reconcileFindingComments(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile"> & Partial<Pick<ReviewConfig, "personality" | "voice" | "lanes">>,
  files: readonly PullRequestFileForComment[],
  identities: Readonly<Record<string, string>>,
  priorReport: ReviewReport | null,
): Promise<() => Promise<void>> {
  const comments = (await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    per_page: 100,
  })).filter(isReviewBotComment);
  const rootsByIdentity = new Map<string, typeof comments>();
  const legacyIds = new Set(priorReport?.findings.map((finding) => finding.id));
  for (const comment of comments) {
    if (comment.in_reply_to_id !== null && comment.in_reply_to_id !== undefined) continue;
    const marker = findingMarker(comment.body);
    if (!marker) continue;
    const identity = marker.identity ?? (legacyIds.has(marker.id) && comment.commit_id === priorReport?.scope.head ? identities[marker.id] : undefined);
    if (!identity) continue;
    rootsByIdentity.set(identity, [...(rootsByIdentity.get(identity) ?? []), comment]);
  }
  const findings = publishedFindings(report, config.profile);
  const activeExistingThreads = findings.some((finding) => rootsByIdentity.has(identities[finding.id] ?? findingIdentity(finding)))
    ? await reviewThreadIdentities(octokit, context)
    : [];
  const newThreads: NewReviewThread[] = [];
  const commentUpdates: Array<{ readonly body: string; readonly id: number }> = [];
  const resolutions: Array<{
    readonly finding: ReviewFinding;
    readonly roots: typeof comments;
    readonly reason: "fixed" | "moved" | "dismissed";
  }> = [];

  for (const finding of findings) {
    const identity = identities[finding.id] ?? findingIdentity(finding);
    const location = reviewCommentLocation(finding, files);
    const body = findingBody(finding, location.subjectType, config.personality)
      .replace(`finding:v2:${findingIdentity(finding)}:`, `finding:v2:${identity}:`);
    const roots = rootsByIdentity.get(identity) ?? [];
    const unresolved = roots.filter((root) => !activeExistingThreads.find((thread) => thread.commentIds.includes(root.id))?.isResolved);
    const prior = unresolved.filter((root) => sameCommentLocation(root, finding, location)).at(-1);
    if (prior && sameCommentLocation(prior, finding, location)) {
      if (prior.body !== body) commentUpdates.push({ body, id: prior.id });
    } else {
      newThreads.push({ body, finding, location });
    }
    const moved = unresolved.filter((root) => !sameCommentLocation(root, finding, location));
    if (moved.length > 0) resolutions.push({ finding, roots: moved, reason: "moved" });
  }

  await createReviewThreads(octokit, context, newThreads, report, {
    ...config,
    blocking: config.blocking && hasBlockingFinding(report),
  });
  for (const finding of report.findings) {
    const roots = rootsByIdentity.get(identities[finding.id] ?? findingIdentity(finding));
    // Unmatched and profile-hidden findings remain open. Absence is not a fix.
    if (finding.dismissal && roots) resolutions.push({ finding, roots, reason: "dismissed" });
    else if (finding.status === "fixed" && roots) resolutions.push({ finding, roots, reason: "fixed" });
  }

  return async () => {
    const failures: unknown[] = [];
    for (const update of commentUpdates) {
      try {
        await verifyPublicationHead(octokit, context);
        await octokit.rest.pulls.updateReviewComment({ owner: context.owner, repo: context.repo, comment_id: update.id, body: update.body });
      } catch (cause) {
        failures.push(new Error(`Review thread update failed for comment ${update.id}`, { cause }));
      }
    }
    const threads = resolutions.length > 0 ? await reviewThreadIdentities(octokit, context) : [];
    for (const resolution of resolutions) {
      try {
        await replyAndResolveFinding(octokit, context, comments, resolution.roots, resolution.finding, resolution.reason, threads);
      } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw threadDeliveryFailure(failures);
  };
}

async function failRunningAxisChecks(
  octokit: OctokitClient,
  context: Omit<TrustedGitHubContext, "patchFingerprint">,
  message: string,
): Promise<void> {
  const listed = await octokit.rest.checks.listForRef({ owner: context.owner, repo: context.repo, ref: context.headSha, per_page: 100 });
  await Promise.all(listed.data.check_runs.filter((check) =>
    check.status !== "completed" && reviewCheckNames.some((prefix) => check.name.startsWith(`${prefix} /`)),
  ).map(async (existing) => {
    await octokit.rest.checks.update({ owner: context.owner, repo: context.repo,
      check_run_id: existing.id, name: existing.name, status: "completed", conclusion: "action_required",
      completed_at: new Date().toISOString(), output: { title: `${existing.name}: incomplete`, summary: message },
    });
  }));
}

async function retireTimelineFindingComments(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  findings: readonly ReviewFinding[],
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    per_page: 100,
  });
  const active = new Set(findings.map((finding) => finding.id));
  for (const comment of comments) {
    if (!isReviewBotComment(comment)) continue;
    const id = timelineMarkerId(comment.body);
    if (!id) continue;
    const body = active.has(id)
      ? retiredTimelineFindingBody(id)
      : inactiveTimelineFindingBody(id);
    if (comment.body !== body) {
      await octokit.rest.issues.updateComment({
        owner: context.owner,
        repo: context.repo,
        comment_id: comment.id,
        body,
      });
    }
  }
}

export async function writeReviewState(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  state: ReviewState,
): Promise<void> {
  if (state.pullRequest !== context.pullRequest) throw new Error("Review state belongs to another pull request");
  const { body, parts } = prepareReviewStateComments(state);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    per_page: 100,
  });
  const existing = comments.find((comment) =>
    isReviewBotComment(comment) && isReviewStateComment(comment.body ?? ""),
  );
  const storedParts = new Set(comments.filter(isReviewBotComment).map((comment) => comment.body));
  for (const part of parts) {
    if (storedParts.has(part)) continue;
    await octokit.rest.issues.createComment({
      owner: context.owner, repo: context.repo, issue_number: context.pullRequest, body: part,
    });
  }
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: context.owner,
      repo: context.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    body,
  });
}

export async function readLatestReviewState(
  octokit: OctokitClient,
  context: Pick<TrustedGitHubContext, "owner" | "repo" | "pullRequest">,
): Promise<ReviewState | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    per_page: 100,
  });
  const trustedComments = comments.filter(isReviewBotComment);
  const bodies = trustedComments.map((comment) => comment.body ?? "");
  return (
    trustedComments
      .filter((comment) => isReviewStateComment(comment.body ?? ""))
      .map((comment) => decodeReviewState(comment.body ?? "", bodies))
      .filter(
        (state): state is ReviewState =>
          state !== null && state.pullRequest === context.pullRequest,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ??
    null
  );
}

export async function markInitialReviewRunning(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
): Promise<void> {
  const state = await readLatestReviewState(octokit, context);
  if (!state) throw new Error("Initial review state is missing");
  if (state.initialFullStatus !== "debouncing" || state.baseline || state.pendingPublication) return;
  await writeReviewState(octokit, context, {
    ...state,
    initialFullStatus: "running",
    updatedAt: new Date().toISOString(),
  });
}

export function validateReportPublicationIdentity(
  context: TrustedGitHubContext,
  identity: ReportAssemblyIdentity,
): ReportAssemblyIdentity {
  const parsed = reportAssemblyIdentitySchema.parse(identity);
  if (
    !context.patchFingerprint ||
    parsed.repositoryId !== context.repositoryId ||
    parsed.pullRequest !== context.pullRequest ||
    parsed.baseSha !== context.baseSha ||
    parsed.headSha !== context.headSha ||
    parsed.patchFingerprint !== context.patchFingerprint
  ) {
    throw new Error(
      "Pending review publication does not match the trusted review",
    );
  }
  return parsed;
}

export function pendingPublicationRetry(
  state: ReviewState,
  context: TrustedGitHubContext,
): NonNullable<ReviewState["pendingPublication"]> | null {
  if (
    state.baseline?.head === context.headSha &&
    state.failure === undefined
  ) {
    return null;
  }
  if (
    state.failure?.failedStage !== "publication" ||
    !state.pendingPublication
  ) {
    return null;
  }
  validateReportPublicationIdentity(context, state.pendingPublication.identity);
  return state.pendingPublication;
}

export async function stageReviewPublication(input: {
  readonly context: TrustedGitHubContext;
  readonly identity: ReportAssemblyIdentity;
  readonly octokit: OctokitClient;
  readonly report: ReviewReport;
}): Promise<ReviewState> {
  const identity = validateReportPublicationIdentity(
    input.context,
    input.identity,
  );
  const report = reviewReportSchema.parse(input.report);
  validateFindingPresentation(report);
  if (
    report.scope.base !== identity.baseSha ||
    report.scope.head !== identity.headSha
  ) {
    throw new Error("Pending review report does not match its trusted identity");
  }
  const current = await readLatestReviewState(input.octokit, input.context);
  const next: ReviewState = {
    ...(current ?? {
      schemaVersion: 2 as const,
      app: legacyCheckName,
      pullRequest: input.context.pullRequest,
      initialFullStatus: "running" as const,
      baseline: null,
    }),
    initialFullStatus: "running",
    currentHead: input.context.headSha,
    pendingPublication: {
      identity,
      report,
      stagedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  findingPublicationMetadata(report, next, input.context);
  await writeReviewState(input.octokit, input.context, next);
  return next;
}

export async function pendingReviewPublication(input: {
  readonly context: TrustedGitHubContext;
  readonly octokit: OctokitClient;
}): Promise<NonNullable<ReviewState["pendingPublication"]>> {
  const state = await readLatestReviewState(input.octokit, input.context);
  if (!state?.pendingPublication) {
    throw new Error("No validated review report is pending publication");
  }
  validateReportPublicationIdentity(
    input.context,
    state.pendingPublication.identity,
  );
  return state.pendingPublication;
}

export async function writeReviewFailureState(input: {
  readonly context: TrustedGitHubContext;
  readonly failure: ReviewFailureEnvelope;
  readonly octokit: OctokitClient;
}): Promise<void> {
  if (
    !input.context.patchFingerprint ||
    input.failure.baseSha !== input.context.baseSha ||
    input.failure.headSha !== input.context.headSha ||
    input.failure.patchFingerprint !== input.context.patchFingerprint
  ) {
    throw new Error("Review failure state does not match the trusted review");
  }
  const pullRequest = await input.octokit.rest.pulls.get({
    owner: input.context.owner,
    repo: input.context.repo,
    pull_number: input.context.pullRequest,
  });
  if (
    pullRequest.data.base.sha !== input.context.baseSha ||
    pullRequest.data.head.sha !== input.context.headSha
  ) {
    throw new Error("Review failure state no longer targets the current head");
  }
  const current = await readLatestReviewState(input.octokit, input.context);
  if (current?.baseline?.head === input.context.headSha && !current.failure) {
    return;
  }
  await writeReviewState(input.octokit, input.context, {
    ...(current ?? {
      schemaVersion: 2 as const,
      app: legacyCheckName,
      pullRequest: input.context.pullRequest,
      initialFullStatus: "failed" as const,
      baseline: null,
    }),
    ...(!current?.baseline && input.failure.planKind === "full"
      ? { initialFullStatus: "failed" as const }
      : {}),
    failure: input.failure,
    updatedAt: new Date().toISOString(),
  });
}

async function verifyPublicationHead(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
): Promise<void> {
  const { data: current } = await octokit.rest.pulls.get({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
  });
  if (
    current.state !== "open" || current.draft ||
    current.base.sha !== context.baseSha || current.head.sha !== context.headSha
  ) {
    throw new Error("Publication no longer matches the reviewable pull request");
  }
}

export async function publishReview(input: {
  readonly config?: Pick<ReviewConfig, "blocking" | "profile"> & Partial<Pick<ReviewConfig, "personality" | "voice" | "lanes">>;
  readonly context: TrustedGitHubContext;
  readonly octokit: OctokitClient;
  readonly reconcileFindings?: boolean;
  readonly report: ReviewReport;
}): Promise<{ readonly checkUrl: string; readonly findingCount: number }> {
  validateFindingPresentation(input.report);
  if (input.report.coverage.unreached.length > 0) {
    throw new ReviewReportValidationError([{ code: "custom", path: ["coverage", "unreached"] }], "Required review coverage is incomplete; publication cannot certify this revision");
  }
  if (
    input.report.scope.head !== input.context.headSha ||
    input.report.scope.base !== input.context.baseSha
  ) {
    throw new Error(
      "Refusing to publish report outside the trusted base and head",
    );
  }
  if (!input.context.patchFingerprint) {
    throw new Error("Trusted review context is missing patch identity");
  }
  const patchFingerprint = input.context.patchFingerprint;
  await verifyPublicationHead(input.octokit, input.context);
  const config = input.config ?? { blocking: false, profile: "balanced" as const };
  const changed = await input.octokit.paginate(
    input.octokit.rest.pulls.listFiles,
    {
      owner: input.context.owner,
      repo: input.context.repo,
      pull_number: input.context.pullRequest,
      per_page: 100,
    },
  );
  for (const file of changed) {
    if (!file.sha) {
      throw new Error(
        `GitHub did not return content identity for ${file.filename}; refusing to advance the review baseline`,
      );
    }
  }
  const patchFiles = parsePullRequestFiles(changed);
  // File pagination is not tied to a commit in GitHub's API. Confirm that
  // it still describes this review before publishing any visible result.
  await verifyPublicationHead(input.octokit, input.context);
  const currentState = await readLatestReviewState(input.octokit, input.context);
  input = { ...input, report: preserveFindingDismissals(input.report, currentState?.baseline?.report ?? null) };
  const threadIdentity = findingPublicationMetadata(input.report, currentState, input.context);
  let cleanupFindingComments: (() => Promise<void>) | null = null;
  if (input.reconcileFindings ?? true) {
    cleanupFindingComments = await reconcileFindingComments(
      input.octokit,
      input.context,
      input.report,
      config,
      changed,
      threadIdentity.identities,
      threadIdentity.prior,
    );
  } else if (config.blocking && hasBlockingFinding(input.report)) {
    await createReviewThreads(
      input.octokit,
      input.context,
      [],
      input.report,
      config,
    );
  }
  if (cleanupFindingComments) {
    await cleanupFindingComments();
    await verifyPublicationHead(input.octokit, input.context);
    await retireTimelineFindingComments(input.octokit, input.context, publishedFindings(input.report, config.profile));
  }
  await verifyPublicationHead(input.octokit, input.context);
  // Approval is a delivery result and must wait for every required thread mutation.
  if (config.blocking && !hasBlockingFinding(input.report)) {
    await createReviewThreads(input.octokit, input.context, [], input.report, config);
  }
  await completeAxisChecks(input.octokit, input.context, input.report, config);
  const check = await upsertCheck(
    input.octokit,
    input.context,
    input.report,
    config,
  );
  const checkUrl =
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`;
  await verifyPublicationHead(input.octokit, input.context);
  await writeReviewState(input.octokit, input.context, {
    schemaVersion: 2,
    app: legacyCheckName,
    pullRequest: input.context.pullRequest,
    initialFullStatus: "completed",
    currentHead: input.context.headSha,
    publication: config,
    baseline: {
      head: input.context.headSha,
      patchFingerprint,
      findingsArtifactUrl: checkUrl,
      reviewPolicyDigest: input.context.reviewPolicyDigest,
      files: effectivePatchFileFingerprints(patchFiles),
      report: input.report,
      findingThreadIdentities: threadIdentity.identities,
      findingRuntimeRequirements: threadIdentity.runtimeRequirements,
    },
    updatedAt: new Date().toISOString(),
  });
  return {
    checkUrl,
    findingCount: publishedFindings(input.report, config.profile).length,
  };
}

export async function publishFailClosedCheck(input: {
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly message: string;
  readonly octokit: OctokitClient;
}): Promise<string> {
  await failRunningAxisChecks(input.octokit, input.context, input.message);
  const existing = await latestCheck(input.octokit, input.context);
  if (existing?.conclusion === "action_required") {
    return (
      existing.html_url ??
      `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
    );
  }
  const report: ReviewReport = {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: new Date().toISOString(),
    verdict: "REQUEST_CHANGES",
    scope: {
      claim: "Review configuration and lifecycle admission",
      base: input.context.baseSha,
      head: input.context.headSha,
      dirtyState: "not inspected",
    },
    coverage: {
      activeAxes: [],
      skippedAxes: [],
      staticOnly: [],
      unreached: ["Review did not start because admission failed closed."],
    },
    churn: { window: "not inspected", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [],
    verifiedClaims: [],
    limitations: [input.message],
  };
  const check = await upsertCheck(
    input.octokit,
    input.context,
    report,
    { blocking: true, profile: "balanced" },
    "action_required",
  );
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
  );
}

export async function publishBudgetExhaustedCheck(input: {
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly budgetAxis: "input" | "output";
  readonly reviewAxis: string;
  readonly usedTokens: number;
  readonly limit: number;
  readonly octokit: OctokitClient;
}): Promise<string> {
  await failRunningAxisChecks(
    input.octokit,
    input.context,
    `This review axis did not complete because the ${input.budgetAxis} token budget was exhausted.`,
  );
  const existing = await latestCheck(input.octokit, input.context);
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name: checkName,
    status: "completed" as const,
    conclusion: "action_required" as const,
    completed_at: new Date().toISOString(),
    output: {
      title: "Slop Sheriff: review incomplete",
      summary: [
        "The review stopped without publishing a verdict because its review execution budget was exhausted.",
        "",
        `Review axis: **${input.reviewAxis}**`,
        `Budget axis: **${input.budgetAxis}**`,
        `Measured usage: **${input.usedTokens.toLocaleString()} tokens**`,
        `Configured cap: **${input.limit.toLocaleString()} tokens**`,
        "",
        "No partial findings were published. Rerun manually only after changing the model, scope, or configured budget.",
      ].join("\n"),
    },
  };
  const check = existing
    ? (
        await input.octokit.rest.checks.update({
          ...common,
          check_run_id: existing.id,
        })
      ).data
    : (
        await input.octokit.rest.checks.create({
          ...common,
          head_sha: input.context.headSha,
          external_id: `${checkName}:${input.context.pullRequest}:${input.context.headSha}`,
        })
      ).data;
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
  );
}

/** Finalize only the still-running attempt that suffered a terminal runtime failure. */
export async function publishSessionFailure(input: {
  readonly context: TrustedGitHubContext;
  readonly message: string;
  readonly octokit: OctokitClient;
}): Promise<void> {
  const { context, octokit } = input;
  if (!context.deliveryId) return;
  const { data: pr } = await octokit.rest.pulls.get({ owner: context.owner, repo: context.repo, pull_number: context.pullRequest });
  if (pr.state !== "open" || pr.draft || pr.base.sha !== context.baseSha || pr.head.sha !== context.headSha) return;
  const check = await latestCheck(octokit, context);
  const review = parseActiveReviewExternalId(check?.external_id, context);
  if (!review || check?.status === "completed" || check?.external_id !== activeReviewExternalId(context, review)) return;
  const state = await readLatestReviewState(octokit, context);
  if (state) {
    await writeReviewState(octokit, context, {
      ...state, currentHead: context.headSha, initialFullStatus: "failed",
      updatedAt: new Date().toISOString(),
    });
  }
  await publishFailClosedCheck(input);
}
