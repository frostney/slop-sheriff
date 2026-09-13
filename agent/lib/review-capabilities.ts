import { defineDynamic, type ToolDefinition } from "eve/tools";
import type { ReviewRoute } from "../../src/models/routing";
import { currentReviewRoute } from "./review-route";

export function isAssignedReviewWork(route: ReviewRoute): boolean {
  return route.role === "lane" && route.workId !== undefined;
}

/** Returning null removes this authored capability from the native model toolset. */
export function outsideReviewWork<Input, Output>(definition: ToolDefinition<Input, Output>) {
  return defineDynamic({ events: {
    "step.started": (_event, ctx) => isAssignedReviewWork(currentReviewRoute(ctx.channel.kind, ctx.messages)) ? null : definition,
  } });
}

export function assignedReviewWorkOnly<Input, Output>(definition: ToolDefinition<Input, Output>) {
  return defineDynamic({ events: {
    "step.started": (_event, ctx) => isAssignedReviewWork(currentReviewRoute(ctx.channel.kind, ctx.messages)) ? definition : null,
  } });
}
