import { z } from "zod";
import { parseFindingDismissal } from "../github/finding-dismissal";
import { requestsManualFullReview } from "../github/manual-full";

export const lifecycleAdmissionSchema = z.object({
  deliveryId: z.string().min(1), repository: z.string().regex(/^[^/]+\/[^/]+$/),
  repositoryId: z.string().min(1), pullRequest: z.number().int().positive(),
  headSha: z.string(), eventTime: z.number().nonnegative(), body: z.string(),
  event: z.string(), signature: z.string(),
});
export type LifecycleAdmission = z.infer<typeof lifecycleAdmissionSchema>;
export const lifecycleJobSchema = lifecycleAdmissionSchema.extend({
  attemptId: z.string(), failureCode: z.string().optional(), status: z.string().optional(), sessionId: z.string().optional(), continuationAddress: z.string().optional(), previousSessionId: z.string().optional(), workerSessionIds: z.array(z.string()).optional(), trustedContext: z.string().optional(), recoveryAuth: z.string().optional(), interruption: z.string().optional(), publicationInterruption: z.string().optional(), recoverySourceAttemptId: z.string().optional(),
  publication: z.string().optional(), publicationKind: z.enum(["report", "failure"]).optional(),
});
export type LifecycleJob = z.infer<typeof lifecycleJobSchema>;

/** Only signed review triggers enter the execution queue. Other comments retain native handling. */
export function parseReviewAdmission(body: string, headers: Headers): LifecycleAdmission | null {
  const suppliedEvent = headers.get("x-github-event");
  const parsed = z.object({ action: z.string(), repository: z.object({ full_name: z.string(), node_id: z.string() }),
    pull_request: z.object({ number: z.number(), head: z.object({ sha: z.string() }), updated_at: z.string() }).optional(),
    issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }).optional(),
    comment: z.object({ body: z.string(), created_at: z.string() }).optional(),
  }).safeParse(JSON.parse(body));
  if (!parsed.success) return null;
  const p = parsed.data;
  const event = suppliedEvent ?? (p.comment && p.issue ? "issue_comment" : p.pull_request ? "pull_request" : "");
  const reviewAction = event === "pull_request" && ["opened", "ready_for_review", "reopened", "synchronize", "closed", "converted_to_draft"].includes(p.action);
  const manual = event === "issue_comment" && p.action === "created" && p.issue?.pull_request !== undefined && (requestsManualFullReview(p.comment?.body ?? "") || parseFindingDismissal(p.comment?.body ?? "") !== null);
  if (!reviewAction && !manual) return null;
  return lifecycleAdmissionSchema.parse({ deliveryId: headers.get("x-github-delivery"), repository: p.repository.full_name,
    repositoryId: p.repository.node_id, pullRequest: p.pull_request?.number ?? p.issue?.number,
    headSha: p.pull_request?.head.sha ?? "", eventTime: Date.parse(p.pull_request?.updated_at ?? p.comment?.created_at ?? ""),
    body, event, signature: headers.get("x-hub-signature-256") ?? "",
  });
}

/** Backoff is transport scheduling, never a review-completeness or spending limit. */
export function lifecycleRetryDelay(attempt: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempt, 8));
}
export function retryableLifecycleError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  return status === 429 || (status !== undefined && status >= 500) || error instanceof TypeError ||
    (error instanceof Error && /timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|network|temporarily unavailable/i.test(error.message));
}
