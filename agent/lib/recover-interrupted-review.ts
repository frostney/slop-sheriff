import { proveNonbillableAttempt } from "../../src/telemetry/cost-client";
import type { RouteHandlerArgs } from "eve/channels";
import { drainNativeReviewDescendants, reconcileNativeWorker } from "../../src/lifecycle/native-worker";
import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import { trustedGitHubContextSchema } from "../../src/github/trusted-context";
import { lifecycleRequest } from "../../src/lifecycle/client";
import { lifecycleJobSchema, type LifecycleJob } from "../../src/lifecycle/contracts";
import { probeReviewPrerequisite, reviewInterruptionSchema } from "../../src/lifecycle/prerequisites";
import { artifactEligibility } from "../../src/review/durable-evidence";
import { recoveryPolicy } from "../../src/lifecycle/recovery-policy";

export async function recoverInterruptedReview(job: LifecycleJob, nativeContext?: Pick<RouteHandlerArgs, "resolveSession" | "attachSession">): Promise<boolean> {
  const deliveryOnly = !!job.publication && (job.publicationKind === "report" || job.failureCode === "publication_failed");
  const rawInterruption = deliveryOnly ? job.publicationInterruption ?? job.interruption : job.interruption;
  if (!rawInterruption) return false;
  const interruption = reviewInterruptionSchema.parse(JSON.parse(rawInterruption));
  const raw = z.object({ installation: z.object({ id: z.number().int().positive() }) }).parse(JSON.parse(job.body));
  const [owner, repo] = job.repository.split("/");
  if (!owner || !repo) return false;
  // GitHub authorization and the current head are checked without starting a model.
  const octokit = githubAdapter(raw.installation.id).octokit;
  const { data: repository } = await octokit.rest.repos.get({ owner, repo });
  if (repository.node_id !== job.repositoryId) return false;
  const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: job.pullRequest });
  if (pull.state !== "open" || pull.draft || job.headSha && pull.head.sha !== job.headSha) return false;
  const expected = job.trustedContext ? trustedGitHubContextSchema.parse(JSON.parse(job.trustedContext)) : null;
  if (expected && (pull.base.sha !== expected.baseSha || pull.head.sha !== expected.headSha)) return false;
  if (deliveryOnly) {
    // Retained reports need only repaired delivery prerequisites, never model credit or new analysis.
    if (interruption.kind !== "github-authentication" && interruption.kind === "deterministic" && interruption.deployment === (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? "local")) return false;
    return z.boolean().parse(await lifecycleRequest("recover", { attemptId: job.attemptId, prerequisiteReady: true, evidenceEligible: false }));
  }
  const prerequisite = await probeReviewPrerequisite(interruption);
  if (!prerequisite.ready) return false;
  // An existing native session needs cryptographically verified, exact-scope evidence.
  // A pre-session admission has no paid analysis to repeat and may safely retry.
  if (!job.sessionId && job.continuationAddress && !nativeContext) return false;
  const resolvedSessionId = job.sessionId ?? (job.continuationAddress ? (await nativeContext?.resolveSession(job.continuationAddress))?.id : undefined);
  const nativeSessionId = !job.sessionId && resolvedSessionId === job.previousSessionId ? undefined : resolvedSessionId;
  if (nativeSessionId) {
    const native = await reconcileNativeWorker(nativeSessionId);
    if (native.kind === "active" || native.kind === "recovered") return false;
    if (native.kind === "missing" || !nativeContext) return false;
    const drain = await drainNativeReviewDescendants(nativeSessionId, job.workerSessionIds ?? [], async sessionId => {
      await nativeContext.attachSession(sessionId).cancel({ tasks: true });
    });
    if (!drain.drained) return false;
    console.info(JSON.stringify({ event: "slop-sheriff.recovery.native-fenced", attemptId: job.attemptId,
      nativeRuns: drain.runIds, unresolvedInFlightSteps: drain.activeStepIds }));
  }
  const policy = expected ? recoveryPolicy(job.recoveryAuth, expected) : null;
  if (policy && !policy.reuse) {
    // A changed runtime policy needs a fresh review under freshly fetched trusted
    // configuration. Never hydrate old-policy artifacts into a paid replacement.
    return z.boolean().parse(await lifecycleRequest("recover", {
      attemptId: job.attemptId, prerequisiteReady: true, evidenceEligible: true,
      discardPriorEvidence: true, progressDigest: policy.digest,
    }));
  }
  const evidence = expected ? await artifactEligibility(job.attemptId, expected) : null;
  const evidenceEligible = !nativeSessionId || evidence?.eligible === true && (evidence.code !== "admission_only_requires_nonbillable_failure_proof" || await proveNonbillableAttempt(job.attemptId));
  if (!evidenceEligible) return false;
  return z.boolean().parse(await lifecycleRequest("recover", { attemptId: job.attemptId, prerequisiteReady: true, evidenceEligible, ...(evidence?.progressDigest ? { progressDigest: evidence.progressDigest } : {}) }));
}
export async function recoverInterruptedReviews(): Promise<void> {
  const jobs = lifecycleJobSchema.array().parse(await lifecycleRequest("claimInterruptions", {}));
  const results = await Promise.allSettled(jobs.map(async job => {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("Lifecycle recovery requires production origin");
    const response = await fetch(`https://${host}/eve/v1/review-lifecycle`, { method: "POST", headers: { authorization: `Bearer ${process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN ?? ""}`, "x-review-attempt": job.attemptId, "x-review-operation": "recover" }, signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) throw new Error("Lifecycle recovery probe unavailable");
  }));
  for (const result of results) if (result.status === "rejected") console.error("Review prerequisite recovery remains interrupted", result.reason instanceof Error ? result.reason.name : "unknown");
}
