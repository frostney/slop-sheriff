import { z } from "zod";
import { reviewAxes, projectLaneIdSchema, maxProjectLanes, type ReviewAxis } from "./axes";
import type { ReviewConfig } from "../config/review-config";

export const trustedReferencePathSchema = z.string().min(1).max(512).refine((path) =>
  !path.startsWith("/") && !path.includes("\\") && !/[\x00-\x1f\x7f:*?\[\]{}]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Expected a literal repository-relative path without traversal or wildcard characters");
export const projectLaneSchema = z.strictObject({
  id: projectLaneIdSchema,
  name: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._()&-]*$/u),
  criteria: z.string().trim().min(1).max(8_000),
  referencePaths: z.array(trustedReferencePathSchema).max(20).default([]),
  applicability: z.strictObject({ paths: z.array(trustedReferencePathSchema).min(1).max(100) }).optional(),
  always: z.boolean().default(false),
}).refine((lane) => lane.always || lane.applicability !== undefined,
  "A project lane requires applicability.paths or always: true");
export const projectLanesSchema = z.array(projectLaneSchema).max(maxProjectLanes).superRefine((lanes, ctx) => {
  if (new Set(lanes.map((lane) => lane.id)).size !== lanes.length ||
      new Set(lanes.map((lane) => lane.name.toLowerCase())).size !== lanes.length ||
      lanes.some((lane) => reviewAxes.some((axis) => axis === lane.name.toLowerCase()))) {
    ctx.addIssue({ code: "custom", message: "Project lane IDs and names must be unique and cannot impersonate a built-in lane" });
  }
});
export type ProjectLane = z.infer<typeof projectLaneSchema>;

export function reviewLaneRegistry(config: Pick<ReviewConfig, "lanes">): readonly { id: ReviewAxis; name: string }[] {
  return [...reviewAxes.map((id) => ({ id, name: id })), ...(config.lanes ?? []).map(({ id, name }) => ({ id, name }))];
}
export function laneCheckName(axis: ReviewAxis, config?: Pick<ReviewConfig, "lanes">): string {
  const lane = config?.lanes?.find((item) => item.id === axis);
  return lane ? `slop-sheriff / ${lane.name} (${lane.id})` : `slop-sheriff / ${axis}`;
}
export function assertConfiguredLane(axis: ReviewAxis, config: Pick<ReviewConfig, "lanes">): void {
  if (!reviewLaneRegistry(config).some((lane) => lane.id === axis)) throw new Error(`Unconfigured review lane ${axis}`);
}

