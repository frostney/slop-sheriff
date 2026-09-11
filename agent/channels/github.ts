import { validateFindingPresentation } from "../../src/github/review-presentation";
import type { ReviewReport } from "../../src/review/findings";
import { connectedGitHubChannel } from "../../src/github/connect-channel";
import { evidenceSigningKey } from "../../src/review/authenticated-evidence";
import {
  defaultGitHubAuth,
  GitHubApiError,
  githubChannel,
  type GitHubComment,
  type GitHubInboundContext,
  type GitHubPullRequestEvent,
} from "eve/channels/github";
import { z } from "zod";
import { fetchBoundedGitHubPages } from "../../src/github/pagination";
import { accessibleRepositoryIds } from "../../src/github/installation-access";
import { readReviewConfigSource } from "../../src/config/review-config-source";
import { parseReviewConfig } from "../../src/config/review-config";
import { validateConfiguredModels } from "../../src/models/catalog";
import { githubAdapter, githubConnector } from "../../src/github/chat-adapter";
import {
  parsePullRequestFiles,
  planDispatch,
  pullRequestDetailsSchema,
  reviewStateFromComments,
} from "../../src/github/inbound";
import {
  addressesKnownGoodReview,
  acknowledgeManualFullReview,
  canRequestManualFull,
  requestsManualFullReview,
  reviewControlResponse,
} from "../../src/github/manual-full";
import {
  reviewCheckNames,
  parseActiveReviewExternalId,
  pendingPublicationRetry,
  publishFailClosedCheck,
  publishInProgressCheck,
  publishReview,
  writeReviewState,
} from "../../src/github/publication";
import { pendingReviewState } from "../../src/github/review-state";
import { withTrustedReviewContext } from "../../src/github/trusted-context";
import { handleGitHubLifecycleWebhook } from "../../src/github/lifecycle";
import { captureMemoryAdmission, requestMemoryDeletion } from "../../src/memory/client";
import { findingsToRevalidate } from "../../src/review/revalidation";
import { reviewAxes } from "../../src/review/axes";
import { selectReviewAxes } from "../../src/review/axis-selection";
import { effectivePatchFingerprint } from "../../src/review/effective-patch";
import { withFreshReviewSessions } from "../../src/github/session-routing";
import { publishPendingReview } from "../lib/publish-review";
import { currentReviewReportState } from "../lib/review-report";

const supportedActions = new Set([
  "closed",
  "converted_to_draft",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

const contentSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

const permissionSchema = z.object({ permission: z.string() });
const repositoryDetailsSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string().min(1),
  created_at: z.iso.datetime(),
});
const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      external_id: z.string().nullable().optional(),
    }),
  ),
});

async function fetchPullRequest(ctx: GitHubInboundContext, number: number) {
  const response = await ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/pulls/${number}`,
  });
  return pullRequestDetailsSchema.parse(response.body);
}

async function fetchRepositoryDetails(ctx: GitHubInboundContext) {
  const response = await ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}`,
  });
  const repository = repositoryDetailsSchema.parse(response.body);
  return {
    repositoryDatabaseId: repository.id,
    repositoryId: repository.node_id,
    repositoryCreatedAt: Date.parse(repository.created_at),
  };
}

async function listAccessibleRepositoryIds(
  installationId: number,
): Promise<string[]> {
  return accessibleRepositoryIds(githubAdapter(installationId).octokit);
}

async function fetchAllPages(
  ctx: GitHubInboundContext,
  path: string,
): Promise<unknown[]> {
  return fetchBoundedGitHubPages(
    (pagePath) => ctx.github.request({ method: "GET", path: pagePath }),
    path,
  );
}

async function fetchTrustedConfig(
  ctx: GitHubInboundContext,
  baseSha: string,
): Promise<string> {
  return readReviewConfigSource(async (path) => {
    try {
      const response = await ctx.github.request({
        method: "GET",
        path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/contents/${path}?ref=${encodeURIComponent(baseSha)}`,
      });
      const file = contentSchema.parse(response.body);
      return Buffer.from(file.content.replaceAll("\n", ""), "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  });
}

async function fetchReviewState(
  ctx: GitHubInboundContext,
  pullRequest: number,
) {
  const [timelineComments, reviewComments] = await Promise.all([
    fetchAllPages(
      ctx,
      `/repos/${ctx.repository.owner}/${ctx.repository.name}/issues/${pullRequest}/comments`,
    ),
    fetchAllPages(
      ctx,
      `/repos/${ctx.repository.owner}/${ctx.repository.name}/pulls/${pullRequest}/comments`,
    ),
  ]);
  return reviewStateFromComments([...timelineComments, ...reviewComments]);
}

async function fetchPatchFiles(
  ctx: GitHubInboundContext,
  pullRequest: number,
) {
  return parsePullRequestFiles(
    await fetchAllPages(
      ctx,
      `/repos/${ctx.repository.owner}/${ctx.repository.name}/pulls/${pullRequest}/files`,
    ),
  );
}

async function fetchActiveReviewIdentity(
  ctx: GitHubInboundContext,
  pullRequest: number,
  baseSha: string,
  headSha: string,
) {
  const responses = await Promise.all(reviewCheckNames.map((name) => ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/commits/${headSha}/check-runs?check_name=${name}&filter=latest&per_page=100`,
  })));
  const checks = responses.flatMap((response) => checkRunsSchema.parse(response.body).check_runs)
    .filter((check) => reviewCheckNames.some((name) => name === check.name))
    .sort((left, right) => right.id - left.id);
  for (const check of checks) {
    const identity = parseActiveReviewExternalId(check.external_id, {
      pullRequest,
      baseSha,
      headSha,
    });
    if (identity) return identity;
  }
  return null;
}

async function hasReviewControlPermission(
  ctx: GitHubInboundContext,
): Promise<boolean> {
  const permissionResponse = await ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/collaborators/${encodeURIComponent(ctx.sender.login)}/permission`,
  });
  return canRequestManualFull(
    permissionSchema.parse(permissionResponse.body).permission,
  );
}

async function reviewMemoryAdmission(ctx: GitHubInboundContext, repositoryId: string): Promise<string | null> {
  const installationId = ctx.github.installationId;
  if (!installationId) return null;
  return captureMemoryAdmission({ installationId, repositoryId }, async () =>
    (await accessibleRepositoryIds(githubAdapter(installationId).octokit, {
      wantedRepositoryId: repositoryId, timeoutMs: 5_000,
    })).includes(repositoryId));
}

function publicationContext(
  ctx: GitHubInboundContext,
  pullRequest: number,
  baseSha: string,
  headSha: string,
  repositoryId: string,
  repositoryCreatedAt: number,
  patchFingerprint?: string,
) {
  const installationId = ctx.github.installationId;
  if (!installationId) {
    throw new Error("GitHub webhook did not include an installation id");
  }
  return {
    installationId,
    owner: ctx.repository.owner,
    repo: ctx.repository.name,
    repository: ctx.repository.fullName,
    repositoryId,
    repositoryCreatedAt,
    pullRequest,
    baseSha,
    headSha,
    patchFingerprint,
  };
}

async function trustedReviewControlAuth(ctx: GitHubInboundContext) {
  const pullRequestNumber = ctx.conversation.pullRequestNumber;
  if (!pullRequestNumber) {
    throw new Error("Review control response did not target a pull request");
  }
  const pullRequest = await fetchPullRequest(ctx, pullRequestNumber);
  if (pullRequest.state !== "open" || pullRequest.draft) {
    throw new Error("The pull request is no longer open and ready for review");
  }
  const [repositoryDetails, configSource, state, patchFiles, activeReview] =
    await Promise.all([
      fetchRepositoryDetails(ctx),
      fetchTrustedConfig(ctx, pullRequest.base.sha),
      fetchReviewState(ctx, pullRequestNumber),
      fetchPatchFiles(ctx, pullRequestNumber),
      fetchActiveReviewIdentity(
        ctx,
        pullRequestNumber,
        pullRequest.base.sha,
        pullRequest.head.sha,
      ),
    ]);
  if (!activeReview) {
    throw new Error("No current-head review identity was found");
  }
  const patchFingerprint = effectivePatchFingerprint(patchFiles);
  const failure = state.kind === "valid" ? state.state.failure : undefined;
  if (failure) {
    if (!failure.retryEligible) {
      throw new Error("The failed review is not eligible for continuation");
    }
    if (
      failure.baseSha !== pullRequest.base.sha ||
      failure.headSha !== pullRequest.head.sha ||
      failure.patchFingerprint !== patchFingerprint ||
      failure.planKind !== activeReview.kind
    ) {
      throw new Error("The failed review no longer matches the current head");
    }
  }

  const deltaDispatch =
    activeReview.kind === "delta"
      ? planDispatch({
          action: "synchronize",
          draft: pullRequest.draft,
          head: pullRequest.head.sha,
          patchFiles,
          state,
        })
      : null;
  if (deltaDispatch && deltaDispatch.plan.kind !== "delta") {
    throw new Error(
      `The active delta review no longer matches the current pull request (${deltaDispatch.plan.kind})`,
    );
  }

  const plan =
    activeReview.kind === "full"
      ? {
          kind: "full" as const,
          delaySeconds: 0 as const,
          reason: activeReview.reason,
          supersedesActiveReview: true,
        }
      : { kind: "delta" as const, revalidatePriorFindings: true as const };
  const config = parseReviewConfig(configSource);
  const reviewFiles = patchFiles
    .filter(
      (file) =>
        activeReview.kind === "full" ||
        deltaDispatch?.changedFiles.includes(file.path),
    )
    .map((file) => ({ path: file.path, status: file.status }));
  const reviewedPaths = reviewFiles.map((file) => file.path);
  const configuredAxes = selectReviewAxes(patchFiles.filter((file) => reviewedPaths.includes(file.path)), config.publicRoots)
    .filter((decision) => decision.selected).map((decision) => decision.axis);
  const pendingIdentity =
    state.kind === "valid"
      ? state.state.pendingPublication?.identity
      : undefined;
  const activeAxes =
    failure?.activeAxes ?? pendingIdentity?.activeAxes ?? configuredAxes;
  const selectedFindingIds =
    failure?.selectedFindingIds ??
    pendingIdentity?.selectedFindingIds ??
    (activeReview.kind === "delta" && deltaDispatch?.priorReport
      ? priorFindingsForReview(
          deltaDispatch.priorReport,
          new Set(deltaDispatch.changedFiles),
        ).map((finding) => finding.id)
      : []);

  const memoryAdmission = await reviewMemoryAdmission(ctx, repositoryDetails.repositoryId);
  const auth = withTrustedReviewContext(defaultGitHubAuth(ctx), {
    baseSha: pullRequest.base.sha,
    configSource,
    event: "review-control-response",
    ...(memoryAdmission ? { memoryAdmission } : {}),
    headSha: pullRequest.head.sha,
    patchFingerprint,
    plan: JSON.stringify({
      ...plan, activeAxes, selectedFindingIds,
      ...(pendingIdentity?.axisDecisions ? { axisDecisions: pendingIdentity.axisDecisions } : {}),
      baselineHead: plan.kind === "delta"
        ? pendingIdentity?.baselineHead ?? deltaDispatch?.priorReport?.scope.head
        : null,
    }),
    ...repositoryDetails,
    reviewFiles,
  });
  const context = publicationContext(
    ctx,
    pullRequestNumber,
    pullRequest.base.sha,
    pullRequest.head.sha,
    repositoryDetails.repositoryId,
    repositoryDetails.repositoryCreatedAt,
    patchFingerprint,
  );
  const admittedContext = { ...context, ...(memoryAdmission ? { memoryAdmission } : {}) };
  return {
    auth,
    config,
    context: admittedContext,
    octokit: githubAdapter(context.installationId).octokit,
    state,
  };
}

async function dispatchReview(input: {
  readonly action:
    | "closed"
    | "converted_to_draft"
    | "opened"
    | "ready_for_review"
    | "reopened"
    | "synchronize";
  readonly ctx: GitHubInboundContext;
  readonly manualFull?: boolean;
  readonly manualFullAuthorized?: boolean;
}) {
  const pullRequestNumber = input.ctx.conversation.pullRequestNumber;
  if (!pullRequestNumber) return null;
  const pullRequest = await fetchPullRequest(input.ctx, pullRequestNumber);
  const repositoryDetails = await fetchRepositoryDetails(input.ctx);

  if (input.action === "opened" && pullRequest.draft) return null;

  if (input.action === "closed" || pullRequest.draft) {
    const plan = input.action === "closed" ? "cleanup" : "cancel";
    const auth = withTrustedReviewContext(defaultGitHubAuth(input.ctx), {
      baseSha: pullRequest.base.sha,
      configSource: "",
      event: input.action,
      headSha: pullRequest.head.sha,
      plan,
      ...repositoryDetails,
      reviewFiles: [],
    });
    return {
      auth,
      title: `${plan} ${input.ctx.repository.fullName}#${pullRequestNumber}`,
      context: [
        `<known-good-review-dispatch>${JSON.stringify({
          operation: plan,
          reason:
            plan === "cleanup" ? "pull request closed or merged" : "pull request is draft",
        })}</known-good-review-dispatch>`,
      ],
    };
  }

  const [configSource, state, patchFiles] = await Promise.all([
    fetchTrustedConfig(input.ctx, pullRequest.base.sha),
    fetchReviewState(input.ctx, pullRequestNumber),
    fetchPatchFiles(input.ctx, pullRequestNumber),
  ]);
  const contextWithoutPatch = publicationContext(
    input.ctx,
    pullRequestNumber,
    pullRequest.base.sha,
    pullRequest.head.sha,
    repositoryDetails.repositoryId,
    repositoryDetails.repositoryCreatedAt,
  );
  let reviewConfig;
  try {
    reviewConfig = parseReviewConfig(configSource);
    evidenceSigningKey(process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY);
    await validateConfiguredModels(reviewConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await publishFailClosedCheck({
      context: contextWithoutPatch,
      message,
      octokit: githubAdapter(contextWithoutPatch.installationId).octokit,
    });
    return null;
  }

  const dispatch = planDispatch({
    action: input.action,
    draft: pullRequest.draft,
    head: pullRequest.head.sha,
    ...(input.manualFull === undefined
      ? {}
      : { manualFull: input.manualFull }),
    ...(input.manualFullAuthorized === undefined
      ? {}
      : { manualFullAuthorized: input.manualFullAuthorized }),
    patchFiles,
    state,
  });
  const context = publicationContext(
    input.ctx,
    pullRequestNumber,
    pullRequest.base.sha,
    pullRequest.head.sha,
    repositoryDetails.repositoryId,
    repositoryDetails.repositoryCreatedAt,
    dispatch.patchFingerprint,
  );
  const octokit = githubAdapter(context.installationId).octokit;

  if (dispatch.plan.kind === "fail-closed") {
    await publishFailClosedCheck({
      context,
      message:
        dispatch.plan.reason === "lost-baseline"
          ? "The prior review baseline is missing or invalid. An authorized write, maintain, or admin user must request a manual full review."
          : "The manual full review request was not authorized.",
      octokit,
    });
    return null;
  }
  if (dispatch.plan.kind === "reuse") {
    if (!dispatch.priorReport || !dispatch.patchFingerprint) {
      await publishFailClosedCheck({
        context,
        message: "Semantic reuse was selected without a valid prior findings artifact.",
        octokit,
      });
      return null;
    }
    await publishReview({
      config: reviewConfig,
      context,
      octokit,
      reconcileFindings: false,
      report: {
        ...dispatch.priorReport,
        generatedAt: new Date().toISOString(),
        scope: {
          ...dispatch.priorReport.scope,
          base: pullRequest.base.sha,
          head: pullRequest.head.sha,
        },
        limitations: [
          ...dispatch.priorReport.limitations,
          "Evidence reused after a merge or rebase changed commit identity without changing the effective pull-request patch.",
        ],
      },
    });
    return null;
  }
  if (dispatch.plan.kind !== "full" && dispatch.plan.kind !== "delta") {
    return null;
  }

  const reviewedPaths = dispatch.plan.kind === "delta"
    ? dispatch.changedFiles
    : patchFiles.map((file) => file.path);
  const axisDecisions = selectReviewAxes(patchFiles.filter((file) => reviewedPaths.includes(file.path)), reviewConfig.publicRoots);
  const activeAxes = axisDecisions.filter((decision) => decision.selected).map((decision) => decision.axis);
  const skippedAxes = reviewAxes.filter((axis) => !activeAxes.includes(axis));

  await publishInProgressCheck({
    activeAxes,
    context,
    octokit,
    review:
      dispatch.plan.kind === "full"
        ? { kind: dispatch.plan.kind, reason: dispatch.plan.reason }
        : { kind: dispatch.plan.kind },
    skippedAxes,
  });

  if (dispatch.plan.kind === "full" && dispatch.plan.reason === "initial") {
    await writeReviewState(
      octokit,
      context,
      pendingReviewState({
        publication: reviewConfig,
        pullRequest: pullRequestNumber,
        status: dispatch.plan.delaySeconds === 600 ? "debouncing" : "running",
      }),
    );
  }

  const priorFindings =
    dispatch.plan.kind === "delta" && dispatch.priorReport
      ? priorFindingsForReview(
          dispatch.priorReport,
          new Set(dispatch.changedFiles),
        )
      : [];
  const envelope = {
    operation: dispatch.plan.kind,
    plan: dispatch.plan,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    patchFingerprint: dispatch.patchFingerprint,
    exactFiles:
      dispatch.plan.kind === "delta" ? dispatch.changedFiles : undefined,
    activeAxes,
    axisDecisions,
    priorFindings:
      dispatch.plan.kind === "delta" && dispatch.priorReport
        ? { findings: priorFindings }
        : undefined,
  };
  const memoryAdmission = await reviewMemoryAdmission(input.ctx, repositoryDetails.repositoryId);
  const auth = withTrustedReviewContext(defaultGitHubAuth(input.ctx), {
    baseSha: pullRequest.base.sha,
    configSource,
    event: input.action,
    ...(memoryAdmission ? { memoryAdmission } : {}),
    headSha: pullRequest.head.sha,
    ...(dispatch.patchFingerprint === undefined
      ? {}
      : { patchFingerprint: dispatch.patchFingerprint }),
    plan: JSON.stringify({
      ...dispatch.plan,
      activeAxes,
      axisDecisions,
      selectedFindingIds: priorFindings.map((finding) => finding.id),
      baselineHead: dispatch.plan.kind === "delta" ? dispatch.priorReport?.scope.head : null,
    }),
    ...repositoryDetails,
    reviewFiles: patchFiles
      .filter(
        (file) =>
          dispatch.plan.kind !== "delta" ||
          dispatch.changedFiles.includes(file.path),
      )
      .map((file) => ({ path: file.path, status: file.status })),
  });
  return {
    auth,
    title: `${dispatch.plan.kind} review ${input.ctx.repository.fullName}#${pullRequestNumber}`,
    context: [
      `<known-good-review-dispatch>${JSON.stringify(envelope)}</known-good-review-dispatch>`,
    ],
  };
}

async function onPullRequest(
  ctx: GitHubInboundContext,
  pullRequest: GitHubPullRequestEvent,
) {
  if (!supportedActions.has(pullRequest.action)) return null;
  return dispatchReview({
    action: pullRequest.action as Parameters<typeof dispatchReview>[0]["action"],
    ctx,
  });
}

async function onComment(ctx: GitHubInboundContext, comment: GitHubComment) {
  if (ctx.conversation.kind !== "pull_request") {
    return null;
  }
  if (!requestsManualFullReview(comment.body)) {
    if (!addressesKnownGoodReview(comment.body)) return null;
    const control = reviewControlResponse(comment.body);
    if (!control) return { auth: defaultGitHubAuth(ctx) };
    if (!(await hasReviewControlPermission(ctx))) {
      await ctx.thread.post(
        "Continuing or stopping a review requires write, maintain, or admin repository permission.",
      );
      return null;
    }
    if (control === "stop") return { auth: defaultGitHubAuth(ctx) };
    try {
      const restored = await trustedReviewControlAuth(ctx);
      if (
        restored.state.kind === "valid" &&
        restored.state.state.baseline?.head === restored.context.headSha &&
        !restored.state.state.failure
      ) {
        await ctx.thread.post("The current-head review is already published.");
        return null;
      }
      const failure =
        restored.state.kind === "valid"
          ? restored.state.state.failure
          : undefined;
      if (failure?.failedStage === "publication") {
        const pending = restored.state.kind === "valid"
          ? pendingPublicationRetry(restored.state.state, restored.context)
          : null;
        const staged = pending
          ? null
          : currentReviewReportState(restored.auth);
        if (pending?.report ?? staged?.report) {
          try {
            await publishPendingReview({
              config: restored.config,
              context: restored.context,
              octokit: restored.octokit,
              ...(staged ? { staged } : {}),
            });
          } catch (error) {
            console.error("known-good-review publication retry failed", error);
            try {
              await publishFailClosedCheck({
                context: restored.context,
                message:
                  "Publication retry failed. The validated report remains staged and no review work was rerun.",
                octokit: restored.octokit,
              });
              await ctx.thread.post(
                "Publication retry failed. The validated report remains staged for another model-free retry.",
              );
            } catch (reportingError) {
              console.error(
                "known-good-review could not report publication retry failure",
                reportingError,
              );
            }
            return null;
          }
          try {
            await ctx.thread.post(
              "Publication resumed from the validated application-owned report. No review lanes or model work were rerun.",
            );
          } catch (error) {
            console.warn(
              "known-good-review could not acknowledge successful publication retry",
              error,
            );
          }
          return null;
        }
      }
      return { auth: restored.auth };
    } catch (error) {
      console.error("known-good-review could not restore review context", error);
      await ctx.thread.post(
        "The active review context could not be restored. Request a new full review instead of approving this stale continuation.",
      );
      return null;
    }
  }
  const authorized = await hasReviewControlPermission(ctx);
  if (!authorized) {
    await ctx.thread.post(
      "A manual full review requires write, maintain, or admin repository permission.",
    );
    return null;
  }
  const dispatch = await dispatchReview({
    action: "synchronize",
    ctx,
    manualFull: true,
    manualFullAuthorized: true,
  });
  if (dispatch && !(await acknowledgeManualFullReview(ctx.thread))) {
    console.warn(
      "known-good-review could not acknowledge the manual review comment",
    );
  }
  return dispatch;
}

const { credentials: githubCredentials, api: githubApi } = connectedGitHubChannel(githubConnector);
const channel = githubChannel({
  botName: "slop-sheriff",
  credentials: githubCredentials,
  api: githubApi,
  turnPolicy: "steer",
  progress: { reactions: false },
  onPullRequest,
  onComment,
  events: {
    // Check Runs, the result summary, and inline finding threads are the
    // product surface. Suppress the ordinary model reply so one turn cannot
    // create a second review surface.
    "message.completed": () => {},
  },
});

const githubRoute = channel.routes.find(
  (route) => route.method === "POST" && route.path === "/eve/v1/github",
);
if (!githubRoute || githubRoute.method !== "POST") {
  throw new Error("Eve GitHub channel did not expose its expected HTTP route");
}
const verifier = githubCredentials.webhookVerifier;
if (!verifier) {
  throw new Error("Vercel Connect GitHub credentials did not provide a verifier");
}

export default {
  ...channel,
  routes: channel.routes.map((route) =>
    route === githubRoute
      ? {
          ...githubRoute,
          handler: async (
            request: Request,
            context: Parameters<typeof githubRoute.handler>[1],
          ) =>
            (await handleGitHubLifecycleWebhook({
              request,
              verifier,
              deleteRepositories: (deletion) => requestMemoryDeletion({
                ...deletion, kind: "repositories", repositoryIds: [...deletion.repositoryIds],
              }),
              reconcileInstallation: (deletion) => requestMemoryDeletion({
                ...deletion, kind: "installation", retainedRepositoryIds: [...deletion.retainedRepositoryIds],
              }),
              listAccessibleRepositories: listAccessibleRepositoryIds,
            })) ??
            githubRoute.handler(request, {
              ...context,
              from: withFreshReviewSessions(context.from),
            }),
        }
      : route,
  ),
};

/** Revalidate legacy overlong findings once so an untouched baseline cannot block delivery. */
function priorFindingsForReview(report: ReviewReport, changedFiles: ReadonlySet<string>) {
  const selected = new Set(findingsToRevalidate(report.findings, changedFiles).map((finding) => finding.id));
  return report.findings.filter((finding) => {
    if (finding.status === "fixed") return false;
    if (selected.has(finding.id)) return true;
    try { validateFindingPresentation(finding); return false; }
    catch { return true; }
  });
}
