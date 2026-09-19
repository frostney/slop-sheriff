import { defineState, type StateHandle } from "eve/context";
import type { ModelMessage } from "ai";
import { parseSubagentRoute, type ReviewRoute } from "../../src/models/routing";
import type { ReviewAxis } from "../../src/review/axes";

export const reviewRouteState = defineState<ReviewRoute | null>("known-good-review.route", () => null);

const coordinatorTaskState = defineState<"adjudication" | "presentation">("slop-sheriff.coordinator-task.v1", () => "adjudication");

/** Only application-validated report reuse may select presentation. Never read model text here. */
export function bindCoordinatorPresentationOnly(eligible: boolean): void {
  coordinatorTaskState.update(() => eligible ? "presentation" : "adjudication");
}

function coordinatorRoute(task: "adjudication" | "presentation"): ReviewRoute {
  return { role: "coordinator", attempt: 0, ...(task === "presentation" ? { task } : {}) };
}

// Installed Eve instrumentation can receive a context snapshot outside authored ALS.
// Its public input has no resolved model/task. Do not fabricate a root task there.
function observeState<T>(state: StateHandle<T>): T | undefined {
  try { return state.get(); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("No active eve context.")) return undefined;
    throw error;
  }
}

/** Observe routing without binding an unbound child or requiring an authored context. */
export function readReviewRoute(channelKind: string | undefined, messages: readonly ModelMessage[]): ReviewRoute | null {
  if (channelKind !== "subagent") {
    const task = observeState(coordinatorTaskState);
    return task === undefined ? null : coordinatorRoute(task);
  }
  const bound = observeState(reviewRouteState);
  if (bound) return bound;
  try { return parseSubagentRoute(messages); }
  catch { return null; }
}

export function currentReviewRoute(channelKind: string | undefined, messages: readonly ModelMessage[]): ReviewRoute {
  if (channelKind !== "subagent") return coordinatorRoute(coordinatorTaskState.get());
  const bound = reviewRouteState.get();
  if (bound) return bound;
  const route = parseSubagentRoute(messages);
  reviewRouteState.update(() => route);
  return route;
}

export function requireReviewLane(axis: ReviewAxis): void {
  const route = reviewRouteState.get();
  if (route?.role !== "lane" || route.axis !== axis) {
    throw new Error("Only the assigned review lane can advance its evidence or checkpoint");
  }
}
