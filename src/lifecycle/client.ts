import { classifyReviewInterruption, type ReviewInterruption } from "./prerequisites";
import { z } from "zod";
import { lifecycleJobSchema, type LifecycleAdmission } from "./contracts";
import type { TrustedGitHubContext } from "../github/trusted-context";

export function lifecycleConfigured(): boolean { return !!process.env.CONVEX_MEMORY_URL && !!process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN; }
export async function lifecycleRequest(operation: string, body: unknown): Promise<unknown> {
  const base = process.env.CONVEX_MEMORY_URL?.replace(/\/$/, "");
  const token = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  if (!base || !token) throw new Error("Durable review lifecycle storage is not configured");
  const response = await fetch(`${base}/review-lifecycle/${operation}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Object.assign(new Error(`Durable review lifecycle ${operation} failed (${response.status})`), { status: response.status });
  return response.json();
}
export async function admitReview(input: LifecycleAdmission): Promise<void> { await lifecycleRequest("admit", input); }
export async function inspectReview(attemptId: string, includeSuperseded = false) { return lifecycleJobSchema.nullable().parse(await lifecycleRequest("inspect", { attemptId, includeSuperseded })); }
export async function assertReviewOwnership(context: Pick<TrustedGitHubContext, "deliveryId">): Promise<void> {
  if (!lifecycleConfigured()) return;
  if (!context.deliveryId || !(await lifecycleRequest("fence", { attemptId: context.deliveryId }))) throw new Error("Review attempt has been superseded or is no longer admitted");
}
export async function activateReview(context: Pick<TrustedGitHubContext, "deliveryId" | "headSha"> & { readonly repositoryId?: string }, sessionId?: string, continuationAddress?: string, recoveryAuth?: unknown, previousSessionId?: string): Promise<void> {
  if (!lifecycleConfigured()) return;
  if (!context.deliveryId || !await lifecycleRequest("activate", { attemptId: context.deliveryId, headSha: context.headSha, ...(context.repositoryId ? { repositoryId: context.repositoryId } : {}), ...(sessionId ? { sessionId } : {}), ...(continuationAddress ? { continuationAddress } : {}), ...("baseSha" in context ? { trustedContext: JSON.stringify(context) } : {}), ...(recoveryAuth ? { recoveryAuth: JSON.stringify(recoveryAuth) } : {}), ...(previousSessionId ? { previousSessionId } : {}) })) throw new Error("Review admission has been superseded");
}
export async function heartbeatReview(context: Pick<TrustedGitHubContext, "deliveryId">, sessionId?: string, workerSessionId?: string): Promise<void> {
  if (!lifecycleConfigured()) return;
  if (!context.deliveryId || !await lifecycleRequest("heartbeat", { attemptId: context.deliveryId, ...(sessionId ? { sessionId } : {}), ...(workerSessionId ? { workerSessionId } : {}) })) throw new Error("Review worker no longer owns this attempt");
}
export async function finishReview(attemptId: string | undefined, outcome: "complete" | "delivered" | "retry" | "interrupted", failureCode?: string, interruption?: ReviewInterruption): Promise<void> {
  if (!lifecycleConfigured() || !attemptId) return;
  await lifecycleRequest("finish", { attemptId, outcome, ...(failureCode ? { failureCode } : {}), ...(outcome === "interrupted" ? { interruption: JSON.stringify(interruption ?? classifyReviewInterruption(failureCode ?? "", "")) } : {}) });
}
export async function stageLifecyclePublication(context: TrustedGitHubContext, kind: "report" | "failure", payload: unknown, interruption?: ReviewInterruption): Promise<void> {
  if (!lifecycleConfigured()) return;
  if (!context.deliveryId || !await lifecycleRequest("stage", { attemptId: context.deliveryId, kind, publication: JSON.stringify(payload), ...(kind === "failure" ? { interruption: JSON.stringify(interruption ?? classifyReviewInterruption("", typeof payload === "object" && payload !== null && "message" in payload ? String(payload.message) : "")) } : {}) })) throw new Error("Cannot stage publication for a superseded attempt");
}
export async function claimReviews() {
  const raw = process.env.REVIEW_EXECUTION_CAPACITY ?? "4";
  const capacity = z.coerce.number().int().positive().parse(raw);
  return lifecycleJobSchema.array().parse(await lifecycleRequest("claim", { capacity }));
}
export async function claimReviewPublications() { return lifecycleJobSchema.array().parse(await lifecycleRequest("claimPublications", {})); }

export async function claimReviewReconciliation() { return lifecycleJobSchema.array().parse(await lifecycleRequest("claimReconciliation", {})); }

export async function claimReviewCancellations() { return lifecycleJobSchema.array().parse(await lifecycleRequest("claimCancellations", {})); }
