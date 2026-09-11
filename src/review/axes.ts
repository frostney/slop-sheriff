export const reviewAxes = [
  "deduplication", "claim-and-specification", "engineering-quality",
  "discoverability", "test-against-spec", "writing-quality", "test-health",
] as const;
export type ReviewAxis = (typeof reviewAxes)[number];
export function isReviewAxis(value: string): value is ReviewAxis {
  return (reviewAxes as readonly string[]).includes(value);
}

/** Packet inclusion is conservative; channel dispatch inspects actual changes. */
export function writingQualityApplies(paths: readonly string[]): boolean {
  return paths.some((path) => !/\.(?:png|jpe?g|gif|webp|ico|avif|woff2?|ttf|mp[34]|zip|gz|pdf|wasm)$/i.test(path) &&
    !/(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/i.test(path));
}
