import { verifyAmbiguousReviewHeads } from "../../src/lifecycle/head-verification";
import { classifyReviewInterruption } from "../../src/lifecycle/prerequisites";
import { recoverInterruptedReviews } from "../lib/recover-interrupted-review";
import { publishQueuedReviewNotices } from "../../src/lifecycle/queued-status";
import { defineSchedule } from "eve/schedules";
import { claimReviews, claimReviewPublications, claimReviewReconciliation, claimReviewCancellations, finishReview } from "../../src/lifecycle/client";
import { retryableLifecycleError } from "../../src/lifecycle/contracts";
import { deliverLifecyclePublication } from "../lib/lifecycle-publication";

export async function dispatchDurableReviews(): Promise<void> {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("Review lifecycle dispatch requires VERCEL_PROJECT_PRODUCTION_URL");
  const maintenance = async (operation: "cancel" | "reconcile", job: { attemptId: string }) => {
    const response = await fetch(`https://${host}/eve/v1/review-lifecycle`, { method: "POST", headers: { authorization: `Bearer ${process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN ?? ""}`, "x-review-attempt": job.attemptId, "x-review-operation": operation }, signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) throw new Error(`Review ${operation} failed (${response.status})`);
  };
  await verifyAmbiguousReviewHeads();
  const cancellationResults = await Promise.allSettled((await claimReviewCancellations()).map(job => maintenance("cancel", job)));
  const reconciliationResults = await Promise.allSettled((await claimReviewReconciliation()).map(job => maintenance("reconcile", job)));
  for (const result of [...cancellationResults, ...reconciliationResults]) if (result.status === "rejected") console.error("Durable review maintenance requires retry", result.reason instanceof Error ? result.reason.name : "unknown");
  const publications = await claimReviewPublications();
  await Promise.allSettled(publications.map(async job => {
    try { await deliverLifecyclePublication(job); await finishReview(job.attemptId, "delivered"); }
    catch (error) { await finishReview(job.attemptId, retryableLifecycleError(error) ? "retry" : "interrupted", "publication_failed", { ...classifyReviewInterruption("publication_failed", error instanceof Error ? error.message : ""), kind: typeof error === "object" && error !== null && "status" in error && [401, 403].includes(Number(error.status)) ? "github-authentication" : "deterministic" }); }
  }));
  await recoverInterruptedReviews();
  await publishQueuedReviewNotices();
  const jobs = await claimReviews();
  await Promise.allSettled(jobs.map(async job => {
    try {
      const response = await fetch(`https://${host}/eve/v1/review-lifecycle`, { method: "POST", headers: {
        authorization: `Bearer ${process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN ?? ""}`,
        "content-type": "application/json", "x-review-attempt": job.attemptId,
        "x-github-delivery": job.attemptId, "x-github-event": job.event,
      }, body: job.body, signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (!response.ok) throw Object.assign(new Error("Durable review dispatch failed"), { status: response.status });
    } catch (error) { console.error("Durable dispatch outcome is unknown; native reconciliation retains its attempt", error instanceof Error ? error.name : "unknown"); }
  }));
}
export default defineSchedule({ cron: "* * * * *", run({ waitUntil }) { waitUntil(dispatchDurableReviews()); } });
