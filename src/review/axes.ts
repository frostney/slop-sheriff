import { z } from "zod";
export const reviewAxes = [
  "deduplication", "claim-and-specification", "engineering-quality",
  "discoverability", "test-against-spec", "writing-quality", "test-health",
] as const;
export type BuiltInReviewAxis = (typeof reviewAxes)[number];
export const projectLaneIdSchema = z.templateLiteral(["project-", z.string().regex(/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,47}$/)]);
export const reviewAxisSchema = z.union([z.enum(reviewAxes), projectLaneIdSchema]);
export type ReviewAxis = z.infer<typeof reviewAxisSchema>;
export const maxProjectLanes = 24;
export const maxReviewLanes = reviewAxes.length + maxProjectLanes;
export function isBuiltInReviewAxis(value: string): value is BuiltInReviewAxis {
  return (reviewAxes as readonly string[]).includes(value);
}
export function isReviewAxis(value: string): value is ReviewAxis {
  return reviewAxisSchema.safeParse(value).success;
}

/** Packet inclusion is conservative; channel dispatch inspects actual changes. */
export function writingQualityApplies(paths: readonly string[]): boolean {
  return paths.some((path) => !/\.(?:png|jpe?g|gif|webp|ico|avif|woff2?|ttf|mp[34]|zip|gz|pdf|wasm)$/i.test(path) &&
    !/(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/i.test(path));
}
