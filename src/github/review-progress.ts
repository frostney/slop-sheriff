import type { ReviewState } from "./review-state";

export function beginCurrentHeadReview(state: ReviewState, headSha: string, status: "running" | "debouncing" | "failed" = "running"): ReviewState {
  const { failure: _failure, pendingPublication: _pending, ...retained } = state;
  return { ...retained, currentHead: headSha, initialFullStatus: status, updatedAt: new Date().toISOString() };
}
