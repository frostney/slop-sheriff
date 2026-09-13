import type { ReviewFinding } from "./review/findings";

export const siteOrigin = "https://slop-sheriff.dev";

/** Reusable artwork, selected without another model call or an authored URL. */
export const findingReactions = {
  BLOCKING: { filename: "slop-sheriff-alarmed-v2.png", alt: "Slop Sheriff looks alarmed" },
  IMPORTANT: { filename: "slop-sheriff-concerned-v2.png", alt: "Slop Sheriff looks skeptical" },
  IMPROVEMENT: { filename: "slop-sheriff-idea-v2.png", alt: "Slop Sheriff has an idea" },
  NITPICK: { filename: "slop-sheriff-nitpick-v2.png", alt: "Slop Sheriff gives a cheeky wink" },
} as const satisfies Record<ReviewFinding["severity"], { filename: string; alt: string }>;

export function findingReactionHtml(severity: ReviewFinding["severity"], absolute: boolean): string {
  const reaction = findingReactions[severity];
  return `<img src="${absolute ? siteOrigin : ""}/assets/${reaction.filename}" width="64" height="64" align="right" alt="${reaction.alt}">`;
}
